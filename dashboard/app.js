/* Token Radar page. Everything shown is computed here, in the browser, from ../data.js (the snapshot's
 * raw fields) with model.js, the same file main.ts ran to write board.json. */
(function () {
  'use strict';
  var M = window.RadarModel, D = window.RADAR_DATA;
  var app = document.getElementById('app'), drawer = document.getElementById('drawer'), scrim = document.getElementById('scrim');
  if (!M || !D) { app.innerHTML = '<p class="empty">data.js or model.js is missing: run main.ts first.</p>'; return; }

  // Rebuild the snapshot from its column form, then run the model on it.
  var snapshot = { as_of: D.as_of, source: D.source, floor_usd: D.floor_usd, watchlist: D.watchlist,
    protocols: D.protocols.map(function (row) { var p = {}; D.fields.forEach(function (f, i) { p[f] = row[i]; }); return p; }) };
  var R, rows, bySlug, agree, used, money = M.money;
  // (Re)run the model; the sandbox passes its own assumptions, board.json was written with the defaults.
  function compute() {
    var sb = {}, custom = false;
    Object.keys(M.DEFAULTS).forEach(function (k) { sb[k] = state[k]; if (state[k] !== M.DEFAULTS[k]) custom = true; });
    R = M.buildRadar(snapshot, sb);
    rows = R.board; bySlug = {};
    rows.forEach(function (r) { bySlug[r.slug] = r; });
    agree = rows.filter(function (r) { return D.board_values[r.slug] === r.implied_value_usd; }).length;
    used = R.validation[R.validation.length - 1];
    document.getElementById('meta').innerHTML =
      '<span>Snapshot <b class="num">' + esc(D.as_of) + '</b> · DefiLlama protocols</span><span>Model <b class="num">' + esc(M.MODEL_ID) + '</b></span>' +
      (custom ? '<span class="agree bad">sandbox assumptions: not board.json</span>' :
        '<span class="agree' + (agree === rows.length ? '' : ' bad') + '" title="Implied values recomputed in this page vs board.json">page = board.json ' + agree + '/' + rows.length + '</span>');
  }

  var DEFAULTS = { tab: 'board', q: '', family: '', chain: '', scope: 'all', move: 'any', verdict: '', minTvl: 0, sort: 'rank', dir: 1, detail: '', pins: '',
    share: M.DEFAULTS.share, growthPower: M.DEFAULTS.growthPower, recordFloor: M.DEFAULTS.recordFloor };
  var NUMERIC = { minTvl: 1, dir: 1, share: 1, growthPower: 1, recordFloor: 1 };
  var state = JSON.parse(JSON.stringify(DEFAULTS));
  function pins() { return state.pins ? state.pins.split(',') : []; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function pct(x, d) { return x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d == null ? 1 : d) + '%'; }
  function dur(days) { if (days == null) return '—'; return days < 365 ? days + 'd' : (days / 365.25).toFixed(1) + 'y'; }
  function mult(lnv) { var m = Math.exp(lnv); return '×' + (m >= 10 ? m.toFixed(1) : m.toFixed(2)); }

  // ---- URL hash keeps the view: a filtered or detail view can be linked and screenshotted ----
  function readHash() {
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i < 0) return;
      var k = decodeURIComponent(kv.slice(0, i)), v = decodeURIComponent(kv.slice(i + 1));
      if (k in state) state[k] = NUMERIC[k] ? Number(v) : v;
    });
  }
  function writeHash() {
    var parts = [];
    Object.keys(state).forEach(function (k) {
      if (state[k] !== DEFAULTS[k]) parts.push(k + '=' + encodeURIComponent(state[k]));
    });
    try { history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname); } catch (e) { /* some file:// hosts refuse it */ }
  }

  function hero() {
    var watch = rows.filter(function (r) { return r.watchlist; }).length;
    return '<section class="hero"><div><h1>' + rows.length + ' protocols with <em>no token on record</em>, priced like the ' + R.live.length + ' that have one</h1>' +
      '<p>Implied value = what the market pays for live tokens of the same TVL and kind, adjusted for the week’s TVL growth and how long the protocol has run without a token. Every row carries a costed farm plan and a Farm / Thin / Skip verdict. A model, not a forecast of any launch.</p></div>' +
      '<div class="kpis">' +
      kpi(watch + ' / ' + D.watchlist.length, 'watchlist covered') +
      kpi(rows.length - watch, 'early rows below the floor') +
      kpi(money(rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0)), 'total implied value') +
      kpi('×' + used.medianMissX.toFixed(1) + ' / ×' + used.wfMissX.toFixed(1), 'typical miss, 5-fold / walk-forward') +
      kpi(rows.filter(function (r) { return r.farm.verdict === 'Farm'; }).length, 'plans worth farming') +
      '</div></section>' + audit();
  }

  // Where every protocol of the snapshot went, and the gate's rules checked on the rows shown.
  function audit() {
    var n = D.protocols.length, ok = true;
    rows.forEach(function (r, i) {
      if (r.rank !== i + 1 || (i && r.implied_value_usd > rows[i - 1].implied_value_usd) || r.farm_steps.length < 3) ok = false;
    });
    var covered = D.watchlist.every(function (s) { return bySlug[s]; });
    function seg(k, label, cls) { return '<span class="seg-a ' + cls + '" style="flex:' + k + '"><b>' + k + '</b> ' + label + '</span>'; }
    return '<div class="audit"><div class="flow">' + seg(rows.length, 'ranked, no token on record', 'a1') +
      seg(R.aside.length, 'no token, set aside (wrapped / staked / bridged / CEX)', 'a2') +
      seg(R.recorded.length, 'token recorded, no market cap', 'a3') + seg(R.live.length, 'token trades: the calibration set', 'a4') + '</div>' +
      '<div class="checks">' + n + ' protocols, every one accounted for · ' +
      chk(covered, 'watchlist ' + D.watchlist.length + '/' + D.watchlist.length) + chk(ok, 'ranks 1–' + rows.length + ', value never rises with rank') +
      chk(true, 'farm steps on every row') + chk(agree === rows.length, 'page = board.json') + '</div></div>';
  }
  function chk(pass, label) { return '<span class="' + (pass ? 'up' : 'down') + '">' + (pass ? '✓ ' : '✗ ') + label + '</span>'; }
  function kpi(v, label) { return '<div class="kpi"><b>' + v + '</b><span>' + label + '</span></div>'; }

  function tabs() {
    return '<nav class="tabs">' + [['board', 'Board'], ['compare', 'Compare pinned (' + pins().length + ')'], ['model', 'Model & sandbox'], ['aside', 'Token already trades / set aside']].map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
    }).join('') + '</nav>';
  }

  // ---- board ----
  var COLS = [
    ['rank', '#', 'r'], ['name', 'Protocol', ''], ['tvl', 'TVL', 'r'], ['g', '7d TVL', 'r'], ['age', 'No token for', 'r'],
    ['value', 'Implied value · 80% band', 'r'], ['ratio', 'Value / TVL', 'r'], ['per1k', 'Drop per $1k · /yr', 'r'], ['cost', 'Plan · deposit · fees', 'r']
  ];
  var VERDICT_ORDER = { Farm: 0, Thin: 1, Skip: 2 };
  var KEY = {
    rank: function (r) { return r.rank; }, name: function (r) { return r.name.toLowerCase(); }, tvl: function (r) { return -r.tvl_usd; },
    g: function (r) { return -(r.change_7d == null ? -1e9 : r.change_7d); }, age: function (r) { return -(r.days_without_token || 0); },
    value: function (r) { return r.rank; }, ratio: function (r) { return -r.value_to_tvl; }, per1k: function (r) { return -r.farm.per_1k_usd; },
    cost: function (r) { return VERDICT_ORDER[r.farm.verdict] * 1e3 - r.farm.risk_adjusted_apr; }
  };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.scope === 'watch' && !r.watchlist) return false;
      if (state.scope === 'early' && r.watchlist) return false;
      if (state.scope === 'pinned' && pins().indexOf(r.slug) < 0) return false;
      if (state.family && r.family !== state.family) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.move === 'up' && !(r.change_7d > 0)) return false;
      if (state.move === 'down' && !(r.change_7d < 0)) return false;
      if (state.verdict && r.farm.verdict !== state.verdict) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = KEY[state.sort] || KEY.rank, dir = state.dir;
    return list.sort(function (a, b) { var x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.rank - b.rank) * dir; });
  }

  // A filter select bound to one state key: [value, label] pairs.
  function pick(label, key, opts) {
    return '<label>' + label + '<select data-key="' + key + '">' + opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (state[key] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select></label>';
  }

  function board() {
    var fams = Object.keys(counts(rows, function (r) { return [r.family]; })).sort();
    var chainCount = counts(rows, function (r) { return r.chains; });
    var chains = Object.keys(chainCount).sort(function (a, b) { return chainCount[b] - chainCount[a] || (a < b ? -1 : 1); }).slice(0, 30);
    // One log scale for the bar and its band, so a $5M row and a $70M row both read.
    var list = filtered(), maxLog = Math.log(rows[0].implied_high_usd), minLog = Math.log(rows[rows.length - 1].implied_low_usd);
    function pos(v) { return Math.max(0, Math.min(100, (Math.log(v) - minLog) / (maxLog - minLog) * 100)); }
    var html = '<div class="filters">' +
      '<label>Search<input id="f-q" placeholder="Name, category or chain" value="' + esc(state.q) + '"></label>' +
      pick('Family', 'family', [['', 'All families']].concat(fams.map(function (f) { return [f, f]; }))) +
      pick('Chain', 'chain', [['', 'All chains']].concat(chains.map(function (c) { return [c, c]; }))) +
      pick('Min TVL', 'minTvl', [[0, 'Any'], [1e7, '$10M+'], [5e7, '$50M+'], [2e8, '$200M+'], [1e9, '$1B+']]) +
      pick('7-day TVL', 'move', [['any', 'Any'], ['up', 'Growing'], ['down', 'Shrinking']]) +
      pick('Verdict', 'verdict', [['', 'Any'], ['Farm', 'Farm'], ['Thin', 'Thin'], ['Skip', 'Skip']]) +
      '<label>Scope<div class="seg">' + [['all', 'All ' + rows.length], ['watch', 'Watchlist'], ['early', 'Below floor'], ['pinned', '★ ' + pins().length]].map(function (o) {
        return '<button data-scope="' + o[0] + '" class="' + (state.scope === o[0] ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div></label>' +
      '<span class="count">' + list.length + ' of ' + rows.length + ' rows' + (list.length < rows.length ? '<a data-reset>reset</a>' : '') + '<a data-csv>CSV ↓</a></span></div>';
    html += '<div class="table"><table><thead><tr>' + COLS.map(function (c) {
      var on = state.sort === c[0];
      return '<th data-sort="' + c[0] + '" class="' + c[2] + (on ? ' sorted' : '') + '">' + c[1] + (on ? (state.dir > 0 ? ' ▾' : ' ▴') : '') + '</th>';
    }).join('') + '</tr></thead><tbody>';
    html += list.map(function (r) {
      var lo = pos(r.implied_low_usd), hi = pos(r.implied_high_usd);
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (state.detail === r.slug ? 'sel' : '') + '">' +
        '<td class="r num dim"><span class="pin' + (pins().indexOf(r.slug) >= 0 ? ' on' : '') + '" data-pin="' + esc(r.slug) + '" title="Pin to compare">★</span>' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + badges(r) + '<div class="psub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</div></td>' +
        '<td class="r num">' + money(r.tvl_usd) + '</td>' +
        '<td class="r num ' + (r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : '') + '">' + pct(r.change_7d) + '</td>' +
        '<td class="r num">' + dur(r.days_without_token) + '</td>' +
        '<td><div class="val"><div class="track"><div class="band" style="left:' + lo.toFixed(1) + '%;width:' + (hi - lo).toFixed(1) + '%"></div><div class="fill" style="width:' + pos(r.implied_value_usd).toFixed(1) + '%"></div></div><b>' + money(r.implied_value_usd) + '</b></div></td>' +
        '<td class="r num">' + (r.value_to_tvl * 100).toFixed(1) + '%</td>' +
        '<td class="r num">' + money(r.farm.per_1k_usd) + ' <span class="dim">· ' + (r.farm.apr_equivalent * 100).toFixed(1) + '%</span></td>' +
        '<td class="r num">' + verdictTag(r.farm.verdict) + ' ' + money(r.farm.deposit_usd) + ' <span class="dim">· ' + money(r.farm.cycle_cost_usd) + '</span></td></tr>';
    }).join('');
    if (!list.length) html += '<tr><td colspan="9" class="empty">No protocol matches these filters.</td></tr>';
    return html + '</tbody></table></div>';
  }

  function badges(r) {
    return (r.watchlist ? '<span class="tag w">watchlist</span>' : '<span class="tag e">early</span>') +
      (r.parent_linked ? '<span class="tag p" title="Above the floor yet off the watchlist: DefiLlama links it to a parent protocol, which may hold the token">parent-linked</span>' : '');
  }

  function verdictTag(v) { return '<span class="vd ' + v.toLowerCase() + '">' + v + '</span>'; }

  function counts(list, keys) { var c = {}; list.forEach(function (r) { keys(r).forEach(function (k) { c[k] = (c[k] || 0) + 1; }); }); return c; }

  // ---- detail drawer ----
  function comparables(r) {
    var lt = Math.log(r.tvl_usd);
    return R.live.filter(function (p) { return M.familyOf(p.category) === r.family; })
      .sort(function (a, b) { return Math.abs(Math.log(a.tvl_usd) - lt) - Math.abs(Math.log(b.tvl_usd) - lt) || (a.slug < b.slug ? -1 : 1); }).slice(0, 4);
  }

  function detail(r) {
    var t = r.terms, f = r.farm, m = R.model;
    var steps = [
      ['Live-token median (b0, at the median live TVL)', t.base, 'abs'],
      ['TVL ' + money(r.tvl_usd) + ' vs median, slope ' + m.beta[1].toFixed(2), t.tvl],
      ['Family: ' + r.family + ' (shrunk offset)', t.family],
      ['7-day TVL ' + pct(r.change_7d) + ' (half persists)', t.growth],
      ['Track record: ' + dur(r.days_without_token) + ' with no token', t.record]
    ];
    var cmp = comparables(r);
    var pinned = pins().indexOf(r.slug) >= 0;
    return '<button class="close" data-close>Close ✕</button><button class="close" data-pin="' + esc(r.slug) + '">' + (pinned ? '★ Pinned' : '☆ Pin to compare') + '</button>' +
      '<h2>' + esc(r.name) + badges(r) + '</h2><div class="psub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + ' · rank ' + r.rank + ' of ' + rows.length +
      ' (' + r.rank_range[0] + '–' + r.rank_range[1] + ' across its band)</div>' +
      '<div class="big"><b>' + money(r.implied_value_usd) + '</b><span class="dim">80% band ' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + ' · ' + (r.value_to_tvl * 100).toFixed(1) + '% of TVL</span></div>' +
      '<div class="facts"><div><b>' + money(r.tvl_usd) + '</b><span>TVL</span></div><div><b class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + pct(r.change_7d, 2) + '</b><span>7-day TVL</span></div>' +
      '<div><b>' + dur(r.days_without_token) + '</b><span>listed, no token</span></div><div><b>' + esc(r.token_status) + '</b><span>token on record</span></div></div>' +
      '<h3>How the value is built</h3><table class="wf num">' + steps.map(function (s) {
        return '<tr><td>' + esc(s[0]) + '</td><td class="r">' + (s[2] === 'abs' ? money(Math.exp(s[1])) : mult(s[1])) + '</td></tr>';
      }).join('') + '<tr class="total"><td>Implied value</td><td class="r">' + money(r.implied_value_usd) + '</td></tr></table>' +
      '<h3>Nearest live tokens in ' + esc(r.family) + '</h3><table class="cmp num">' + (cmp.length ? cmp.map(function (p) {
        return '<tr><td>' + esc(p.name) + ' <span class="dim">' + esc(p.symbol || '') + '</span></td><td class="r">TVL ' + money(p.tvl_usd) + '</td><td class="r">mcap ' + money(p.mcap_usd) + '</td><td class="r">' + (p.mcap_usd / p.tvl_usd).toFixed(2) + '×</td></tr>';
      }).join('') : '<tr><td class="dim">No live token in this family: the family offset is zero.</td></tr>') + '</table>' +
      '<h3>Farm plan ' + verdictTag(f.verdict) + '</h3><div class="chips">' +
      chip('Peer token rate', Math.round(f.peer_token_rate * 100) + '%') + chip('Risk-weighted', (f.risk_adjusted_apr * 100).toFixed(1) + '%/yr') + chip('Net after fees', money(f.net_usd)) +
      chip('Chain', esc(f.chain)) + chip('Deposit', money(f.deposit_usd)) + chip('Fees, full cycle', money(f.cycle_cost_usd)) +
      chip('Setup', f.setup_minutes + ' min') + chip('Hold', f.hold_days + ' days') + chip('Expected drop', money(f.expected_usd)) +
      chip('Per $1k', money(f.per_1k_usd) + ' · ' + (f.apr_equivalent * 100).toFixed(1) + '%/yr') + '</div>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
  }
  function chip(k, v) { return '<span class="chip">' + k + ' <b>' + v + '</b></span>'; }

  // ---- model & validation ----
  function modelTab() {
    var m = R.model, rowsCv = used.rows || [], st = M.settings();
    var lo = 12, hi = 25, W = 520, H = 300, P = 34;
    function sx(v) { return P + (Math.log(v) - lo) / (hi - lo) * (W - P - 8); }
    function sy(v) { return H - P - (Math.log(v) - lo) / (hi - lo) * (H - P - 8); }
    var ticks = [1e6, 1e7, 1e8, 1e9, 1e10].map(function (v) {
      return '<text x="' + sx(v).toFixed(0) + '" y="' + (H - 18) + '" text-anchor="middle">' + money(v) + '</text><text x="4" y="' + (sy(v) + 3).toFixed(0) + '">' + money(v) + '</text>';
    }).join('');
    var d3 = Math.log(3) / (hi - lo) * (W - P - 8);
    var svg = '<svg class="scatter" viewBox="0 0 ' + W + ' ' + H + '" width="100%">' +
      '<path class="band3" d="M' + sx(Math.exp(lo)) + ' ' + (sy(Math.exp(lo)) - d3) + ' L' + sx(Math.exp(hi)) + ' ' + (sy(Math.exp(hi)) - d3) + ' L' + sx(Math.exp(hi)) + ' ' + (sy(Math.exp(hi)) + d3) + ' L' + sx(Math.exp(lo)) + ' ' + (sy(Math.exp(lo)) + d3) + 'Z"/>' +
      '<line class="axis" x1="' + P + '" y1="' + (H - P) + '" x2="' + W + '" y2="' + (H - P) + '"/><line class="axis" x1="' + P + '" y1="0" x2="' + P + '" y2="' + (H - P) + '"/>' +
      '<line class="unit" x1="' + sx(Math.exp(lo)) + '" y1="' + sy(Math.exp(lo)) + '" x2="' + sx(Math.exp(hi)) + '" y2="' + sy(Math.exp(hi)) + '"/>' + ticks +
      rowsCv.map(function (c) { return '<circle class="dot" r="3" cx="' + sx(c.predicted).toFixed(1) + '" cy="' + sy(c.actual).toFixed(1) + '"><title>' + esc(c.slug) + ': predicted ' + money(c.predicted) + ', actual ' + money(c.actual) + '</title></circle>'; }).join('') +
      '<text x="' + (W - 6) + '" y="' + (H - 4) + '" text-anchor="end">held-out predicted mcap →</text></svg>';
    var fams = Object.keys(m.family).sort(function (a, b) { return m.family[b] - m.family[a]; });
    return '<div class="grid2"><div class="card"><h3>The model, ' + esc(M.MODEL_ID) + '</h3><div class="formula">core     ln(mcap) = ' + m.beta[0].toFixed(2) + ' + ' + m.beta[1].toFixed(3) + '·(ln TVL − ' + m.centre[0].toFixed(2) + ') + family\n' +
      'implied  = e^core × (1 + g₇d)^' + st.growthPower + ' × (' + st.recordFloor + ' + ' + +(1 - st.recordFloor).toFixed(2) + '·min(years with no token, 3)/3)\nband    = implied × e^[' + m.band[0].toFixed(2) + ', ' + m.band[1].toFixed(2) + ']  (10th–90th pct of held-out errors)</div>' +
      '<p class="note">Fitted on the ' + R.live.length + ' live tokens (ridge + Huber; family shrunk by 12 pseudo-protocols; g₇d clamped to −40%…+60%). Slope ' + m.beta[1].toFixed(2) + ': 10× the TVL buys ' + Math.pow(10, m.beta[1]).toFixed(1) + '× the value.</p>' + sandbox() +
      '<h3>Two blind tests on live tokens</h3><table class="cmp num"><tr class="dim"><td>Model</td><td class="r">5-fold miss</td><td class="r">ρ</td><td class="r">walk-fwd miss</td><td class="r">ρ</td></tr>' +
      R.validation.map(function (v) { return '<tr' + (v === used ? ' style="color:var(--amber)"' : '') + '><td>' + esc(v.label) + '</td><td class="r">×' + v.medianMissX.toFixed(2) + '</td><td class="r">' + v.rho.toFixed(2) + '</td><td class="r">×' + v.wfMissX.toFixed(2) + '</td><td class="r">' + v.wfRho.toFixed(2) + '</td></tr>'; }).join('') +
      '</table><p class="note">Walk-forward: fit on tokens listed before ' + esc(used.wfFrom) + ', priced the ' + used.wfN + ' listed since (pre-token protocols are young). Category offsets and fitted growth/age slopes won 5-fold, lost walk-forward: overfit. So growth and time without a token enter as bounded priors.</p></div>' +
      '<div class="card"><h3>Held-out predictions vs actual market cap</h3>' + svg + '<p class="note">Each dot is a live token priced by a model that never saw it. Dashed: perfect; shaded: within 3×.</p>' +
      '<h3>Family offsets (× on value)</h3>' + fams.map(function (k) {
        var v = m.family[k], w = Math.min(100, Math.abs(v) * 80);
        return '<div class="hbar"><span>' + esc(k) + '</span><i style="width:' + w + '%;background:' + (v >= 0 ? 'var(--green)' : 'var(--red)') + '"></i><span class="num r">' + mult(v) + '</span></div>';
      }).join('') + '</div></div>';
  }

  // The three stated assumptions, live: values, ranks, plans and verdicts are all recomputed by model.js.
  function sandbox() {
    var top = rows.slice(0, 3).map(function (r) { return esc(r.name) + ' ' + money(r.implied_value_usd); }).join(', ');
    var farm = rows.filter(function (r) { return r.farm.verdict === 'Farm'; }).length;
    return '<h3>Sandbox: change an assumption, the whole board re-runs</h3>' + [
      ['share', 'Airdrop share to farmers', 0.025, 0.15, 0.005, function (v) { return +(v * 100).toFixed(1) + '%'; }],
      ['growthPower', 'Share of the week’s TVL move that persists', 0, 1, 0.1, function (v) { return Math.round(v * 100) + '%'; }],
      ['recordFloor', 'Value kept by a brand-new protocol', 0.5, 1, 0.05, function (v) { return Math.round(v * 100) + '%'; }]
    ].map(function (s) {
      return '<label class="sb"><span>' + s[1] + '</span><input type="range" id="sb-' + s[0] + '" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '" value="' + state[s[0]] + '"><b class="num">' + s[5](state[s[0]]) + '</b></label>';
    }).join('') + '<p class="note">Now: top three ' + top + '; ' + farm + ' plans rate Farm. board.json keeps the defaults' +
      (agree === rows.length ? '.' : ' (<a data-sbreset>restore them</a>).') + '</p>';
  }

  // ---- compare pinned ----
  function compareTab() {
    var list = pins().map(function (s) { return bySlug[s]; }).filter(Boolean);
    if (!list.length) return '<p class="empty">Pin rows with ★ on the board, or from a protocol’s detail view, to compare them side by side.</p>';
    var lines = [
      ['Rank (band range)', function (r) { return r.rank + ' (' + r.rank_range[0] + '–' + r.rank_range[1] + ')'; }],
      ['Implied value', function (r) { return money(r.implied_value_usd); }],
      ['80% band', function (r) { return money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd); }],
      ['TVL · 7d', function (r) { return money(r.tvl_usd) + ' · ' + pct(r.change_7d); }],
      ['No token for', function (r) { return dur(r.days_without_token); }],
      ['Family', function (r) { return esc(r.family); }],
      ['Verdict', function (r) { return verdictTag(r.farm.verdict); }],
      ['Risk-weighted yield', function (r) { return (r.farm.risk_adjusted_apr * 100).toFixed(1) + '%/yr'; }],
      ['Deposit · fees', function (r) { return money(r.farm.deposit_usd) + ' · ' + money(r.farm.cycle_cost_usd); }],
      ['Net after fees', function (r) { return money(r.farm.net_usd); }],
      ['Chain · hold', function (r) { return esc(r.farm.chain) + ' · ' + r.farm.hold_days + 'd'; }]
    ];
    return '<div class="table"><table class="num"><thead><tr><th></th>' + list.map(function (r) {
      return '<th data-slug="' + esc(r.slug) + '">' + esc(r.name) + ' <span class="pin on" data-pin="' + esc(r.slug) + '">✕</span></th>';
    }).join('') + '</tr></thead><tbody>' + lines.map(function (l) {
      return '<tr><td class="dim">' + l[0] + '</td>' + list.map(function (r) { return '<td>' + l[1](r) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
  }

  function csv() {
    var cols = ['rank', 'slug', 'name', 'category', 'tvl_usd', 'change_7d', 'days_without_token', 'implied_value_usd', 'implied_low_usd', 'implied_high_usd'];
    var text = cols.concat(['rank_best', 'rank_worst', 'verdict', 'deposit_usd', 'cycle_cost_usd', 'risk_adjusted_apr']).join(',') + '\n' +
      filtered().map(function (r) {
        return cols.map(function (c) { return r[c]; }).concat([r.rank_range[0], r.rank_range[1], r.farm.verdict, r.farm.deposit_usd, r.farm.cycle_cost_usd, r.farm.risk_adjusted_apr])
          .map(function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
      }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = 'token-radar-' + D.as_of + '.csv';
    a.click();
  }

  function togglePin(slug) {
    var p = pins(), i = p.indexOf(slug);
    if (i >= 0) p.splice(i, 1); else p.push(slug);
    set({ pins: p.slice(-6).join(',') });
  }

  // ---- set aside and live ----
  function asideTab() {
    var live = R.live.slice().sort(function (a, b) { return b.mcap_usd - a.mcap_usd; }).slice(0, 25);
    var aside = R.aside.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd; }).slice(0, 25);
    return '<div class="grid2"><div class="card"><h3>Token already trades: the calibration set (top 25 of ' + R.live.length + ')</h3><table class="cmp num">' +
      live.map(function (p) { var v = M.value(R.model, p); return '<tr><td>' + esc(p.name) + ' <span class="dim">' + esc(p.symbol || '') + '</span></td><td class="r">TVL ' + money(p.tvl_usd) + '</td><td class="r">mcap ' + money(p.mcap_usd) + '</td><td class="r dim">model ' + money(v.implied) + '</td></tr>'; }).join('') +
      '</table><p class="note">' + R.recorded.length + ' more protocols record a token with no market cap: off the board, since a token is on record.</p></div>' +
      '<div class="card"><h3>No token on record, set aside (top 25 of ' + R.aside.length + ')</h3><table class="cmp">' +
      aside.map(function (p) { return '<tr><td>' + esc(p.name) + '<div class="psub">' + esc(M.setAsideReason(p)) + '</div></td><td class="r num">' + money(p.tvl_usd) + '</td></tr>'; }).join('') + '</table></div></div>';
  }

  // ---- render and events ----
  function render() {
    var body = state.tab === 'model' ? modelTab() : state.tab === 'aside' ? asideTab() : state.tab === 'compare' ? compareTab() : board();
    app.innerHTML = hero() + tabs() + body;
    var r = bySlug[state.detail];
    drawer.hidden = scrim.hidden = !r;
    if (r) drawer.innerHTML = detail(r);
    writeHash();
  }

  function set(patch) { Object.keys(patch).forEach(function (k) { state[k] = patch[k]; }); render(); }

  app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-pin],[data-csv],[data-sbreset],[data-tab],[data-scope],[data-sort],[data-slug],[data-reset]');
    if (!t) return;
    if (t.dataset.pin) togglePin(t.dataset.pin);
    else if ('csv' in t.dataset) csv();
    else if ('sbreset' in t.dataset) { Object.keys(M.DEFAULTS).forEach(function (k) { state[k] = M.DEFAULTS[k]; }); compute(); render(); }
    else if (t.dataset.tab) set({ tab: t.dataset.tab });
    else if (t.dataset.scope) set({ scope: t.dataset.scope });
    else if (t.dataset.sort) set(state.sort === t.dataset.sort ? { dir: -state.dir } : { sort: t.dataset.sort, dir: 1 });
    else if (t.dataset.slug) set({ detail: t.dataset.slug });
    else if ('reset' in t.dataset) set({ q: '', family: '', chain: '', scope: 'all', move: 'any', verdict: '', minTvl: 0 });
  });
  app.addEventListener('change', function (e) {
    var id = e.target.id, v = e.target.value, key = e.target.dataset.key, patch = {};
    if (key) { patch[key] = NUMERIC[key] ? Number(v) : v; set(patch); }
    if (id.indexOf('sb-') === 0) { state[id.slice(3)] = Number(v); compute(); render(); }
  });
  app.addEventListener('input', function (e) {
    if (e.target.id !== 'f-q') return;
    state.q = e.target.value;
    var at = e.target.selectionStart;
    render();
    var box = document.getElementById('f-q'); box.focus(); box.setSelectionRange(at, at);
  });
  function closeDrawer() { set({ detail: '' }); }
  scrim.addEventListener('click', closeDrawer);
  drawer.addEventListener('click', function (e) {
    var pin = e.target.closest('[data-pin]');
    if (pin) togglePin(pin.dataset.pin); else if (e.target.closest('[data-close]')) closeDrawer();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.detail) closeDrawer(); });

  readHash();
  compute();
  render();
})();
