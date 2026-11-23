// Token Radar: reads the sealed DefiLlama snapshot, prices every protocol that records no token with a
// model calibrated on the snapshot's own live tokens, and writes the board, the page and the dossier.
//
// The model is dashboard/model.js, a plain script the page also loads: this program runs that exact file
// in a Node vm context, so board.json and the page come from one piece of code and cannot drift apart.
//
// Local run (MAKEFUN_OUTPUT_DIR stands in for /output):
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { buildDossier } from './vendor/makefun-board.ts';

const root = dirname(fileURLToPath(import.meta.url));

function option(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`token-radar: ${message}\n`);
  process.exit(1);
}

let inputPath = option('--input') ?? '/input/snapshot.json';
if (existsSync(inputPath) && statSync(inputPath).isDirectory()) inputPath = join(inputPath, 'snapshot.json');
if (!existsSync(inputPath)) fail(`snapshot not found at ${inputPath}`);
const outDir = option('--output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));

// Load the shared model exactly as the browser does: one global, RadarModel.
const sandbox: Record<string, any> = {};
createContext(sandbox);
runInContext(readFileSync(join(root, 'dashboard', 'model.js'), 'utf8'), sandbox, { filename: 'dashboard/model.js' });
const radar = sandbox.RadarModel.buildRadar(snapshot);
const rows: any[] = radar.board;

// The gate's own rules, checked before anything is written.
function boardProblem(): string | null {
  if (rows.length < 100 || rows.length > 4000) return `${rows.length} rows; the gate wants 100 to 4000`;
  const known = new Set(snapshot.protocols.map((p: any) => p.slug));
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!known.has(r.slug) || seen.has(r.slug)) return `slug ${r.slug} unknown or repeated`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `rank ${r.rank} at position ${i + 1}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) return `bad value for ${r.slug}`;
    if (i > 0 && r.implied_value_usd > rows[i - 1].implied_value_usd) return `value rises at rank ${r.rank}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a step of ${s.trim().length} chars`;
  }
  if (new Set(rows.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  const missing = snapshot.watchlist.filter((s: string) => !seen.has(s));
  return missing.length ? `watchlist not covered: ${missing.join(', ')}` : null;
}
const problem = boardProblem();
if (problem) fail(`the board would fail the gate: ${problem}`);

mkdirSync(outDir, { recursive: true });

const model = radar.model;
writeFileSync(join(outDir, 'board.json'), JSON.stringify({
  model: model.id,
  as_of: snapshot.as_of,
  source: snapshot.source,
  method: 'implied = exp(b0 + b1 ln TVL + family + category) x (1+g7d)^0.5 x track-record factor; fitted on the snapshot\'s live tokens, 5-fold held out',
  validation: radar.validation.map((v: any) => ({ model: v.label, median_miss_x: +v.medianMissX.toFixed(3), spearman: +v.rho.toFixed(3), within_3x: +v.within3x.toFixed(3) })),
  rows,
}, null, 1) + '\n');

// The page's data: every protocol's raw fields (the page refits the model from them) plus the board's
// values, which the page compares with its own result to show that screen and board agree.
const fields = ['slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'mcap_usd', 'listed_at', 'gecko_id', 'symbol'];
const data = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  watchlist: snapshot.watchlist,
  protocols: snapshot.protocols.map((p: any) => fields.map((f) => p[f])),
  fields,
  board_values: Object.fromEntries(rows.map((r) => [r.slug, r.implied_value_usd])),
};
writeFileSync(join(outDir, 'data.js'), `window.RADAR_DATA = ${JSON.stringify(data)};\n`);

function copyTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const st = statSync(src);
    if (st.isDirectory()) n += copyTree(src, join(to, name));
    else if (st.isFile()) { copyFileSync(src, join(to, name)); n++; }
  }
  return n;
}
const pageFiles = copyTree(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyTree(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shots < 3) fail(`screenshots/ holds ${shots} images; the gate wants 3 or 4`);

// Last: the dossier the judge reads, rebuilt byte for byte by the gate from this same /output.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
}));

const top = rows[0];
process.stdout.write(`token-radar: ${rows.length} pre-token rows ranked (${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist), `
  + `${radar.live.length} live tokens calibrate, ${radar.aside.length} set aside; #1 ${top.name} ${top.implied_value_usd}\n`
  + `token-radar: wrote board.json, data.js, dashboard/ (${pageFiles} files), screenshots/ (${shots}) and dossier.json to ${outDir}\n`);
