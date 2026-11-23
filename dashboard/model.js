/* Token Radar model, radar-cal-2.
 *
 * One file, two readers: main.ts runs it in Node to write board.json, and the page runs the very same
 * code in the browser, so every number on screen is recomputed from the snapshot's raw fields.
 *
 * The question: if a protocol's record stayed as it is, what would its token be worth?
 * The snapshot itself answers it: 128 of its protocols already have a trading token with a market cap.
 * We fit how the market prices those tokens from the same figures every protocol carries, then apply the
 * fit to the protocols that record no token yet.
 *
 *   core:     ln(mcap) = b0 + b1 ln(TVL) + family                    (fitted on the live tokens)
 *   implied = exp(core) x growth factor x track-record factor           (stated priors, bounded)
 *
 * The core is fitted by ridge-regularised, Huber-weighted least squares; family offsets are shrunk to
 * zero by 12 pseudo-protocols. Two blind tests on the live tokens pick it: 5-fold held-out, and a
 * walk-forward that fits the oldest 60% by listing day and prices the newest 40%. Per-category offsets,
 * and growth and age fitted as slopes, each won the first test and lost the second (the validation table
 * shows it), so the category offsets were dropped and growth and age enter as bounded priors on how
 * durable the TVL is, not as fitted slopes. The 5-fold errors give the band beside every implied value:
 *   growth factor       = (1 + g)^0.5, g = 7-day TVL change clamped to -40%..+60%  -> x0.77..x1.26
 *   track-record factor = 0.75 + 0.25 x min(days with no token, 3 years) / 3 years -> x0.75..x1.00
 * No protocol name is ever special-cased: the same functions score every row.
 */
(function (root) {
  'use strict';

  var MODEL_ID = 'radar-cal-2';
  var DAY = 86400000;
  var RIDGE = 2;          // pull on the three slopes (features are centred)
  var FAMILY_PRIOR = 12;  // pseudo-protocols at zero offset behind each family effect
  var FOLDS = 5;
  var AIRDROP_SHARE = 0.075; // share of a launch value assumed to go to users who farmed it
  var GROWTH_POWER = 0.5;     // half of the snapshot week's TVL move is taken to persist
  var GROWTH_CLAMP = [-40, 60];
  var RECORD_FLOOR = 0.75;    // a brand-new protocol keeps 75% of the calibrated value
  var RECORD_YEARS = 3;       // ... rising to 100% after three years with no token

  // Categories grouped by how a reader would farm them and how the market prices them.
  var FAMILY = {
    'Yield & vaults': ['Risk Curators', 'Onchain Capital Allocator', 'Yield', 'Yield Aggregator', 'Basis Trading', 'Liquidity Manager', 'Farm', 'Leveraged Farming', 'Options Vault', 'Indexes', 'Governance Incentives'],
    'Credit & stablecoins': ['Lending', 'CDP', 'CDP Manager', 'Uncollateralized Lending', 'Collateral Markets', 'Collateral Management', 'Dual-Token Stablecoin', 'Stablecoin Wrapper', 'Algo-Stables', 'Interest Rate Derivatives'],
    'Trading': ['Dexs', 'Derivatives', 'Options', 'Prediction Market', 'OTC Marketplace', 'Launchpad', 'NFT Marketplace', 'DOR'],
    'Real-world & payments': ['RWA', 'CeDeFi', 'Payments', 'Crypto Card Issuer', 'Insurance'],
    'Staking & BTC': ['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Staking Pool', 'Restaked BTC', 'Anchor BTC', 'Decentralized BTC'],
    'Bridges': ['Bridge', 'Canonical Bridge', 'Cross Chain Bridge'],
    'Chains & infra': ['Chain', 'Privacy', 'AI Agents', 'Decentralized AI', 'Token Locker']
  };
  var FAMILY_OF = {};
  Object.keys(FAMILY).forEach(function (f) { FAMILY[f].forEach(function (c) { FAMILY_OF[c] = f; }); });
  function familyOf(category) { return category == null ? 'Other' : (FAMILY_OF[category] || 'Other'); }

  // Rough cost of one transaction, in US dollars, by chain: an assumption, stated on the page.
  var TX_COST = { Ethereum: 4, Bitcoin: 3, Tron: 1.2, Ripple: 0.01, Solana: 0.02, Binance: 0.12, Avalanche: 0.15,
    Polygon: 0.03, Arbitrum: 0.06, Base: 0.04, Optimism: 0.05, Linea: 0.06, Sonic: 0.03, Monad: 0.03,
    'Hyperliquid L1': 0.02, Plasma: 0.01, Sui: 0.02, Cardano: 0.25, TON: 0.05, Stellar: 0.01, Berachain: 0.05 };
  var TX_DEFAULT = 0.2;
  // Chains whose users do not hold USDC or ETH as a rule: what to bring instead.
  var NATIVE = { Bitcoin: 'BTC', Bittensor: 'TAO', Ripple: 'XRP', Cardano: 'ADA', TON: 'TON', Stellar: 'XLM', Litecoin: 'LTC',
    Doge: 'DOGE', Tron: 'USDT', Sui: 'SUI', Solana: 'SOL', Aptos: 'APT', Near: 'NEAR', Noble: 'USDC', Starknet: 'STRK', Flare: 'FLR' };

  /** How a protocol stands on token: live (trades, has a market cap), recorded (no market cap), pre-token. */
  function tokenStatus(p) {
    if (p.mcap_usd != null && p.mcap_usd > 0) return 'live';
    if (p.gecko_id != null || p.symbol != null) return 'recorded';
    return 'pre';
  }

  // The watchlist's own test for a product of a token that already trades, applied below the floor too.
  var PRODUCT_CATEGORIES = { 'Bridge': 1, 'Canonical Bridge': 1, 'Liquid Staking': 1, 'Liquid Restaking': 1, 'Restaked BTC': 1 };
  var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  var WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
  var EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

  /** Why a pre-token protocol is kept off the ranked board, or null when it is ranked. */
  function setAsideReason(p) {
    if (p.category === 'CEX') return 'Exchange custody wallets: no protocol token to farm.';
    if (PRODUCT_CATEGORIES[p.category]) return p.category + ': a wrapped, staked or bridged form of an asset that already trades.';
    if (EXCHANGE_NAME.test(p.name)) return 'An exchange’s product: its value sits with the exchange’s own token.';
    if (WRAPPED_WORD.test(p.name)) return 'Named as a wrapped or staked product of another asset.';
    if (VERSIONED.test(p.name)) return 'A versioned deployment: its token, if any, is the parent protocol’s.';
    return null;
  }

  function ageDays(p, asOf) {
    if (!p.listed_at) return null;
    return Math.max(0, Math.round((Date.parse(asOf) - Date.parse(p.listed_at)) / DAY));
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  /** The three numeric features, before centring. Missing values take the calibration median. */
  function rawFeatures(p, asOf, fill) {
    var age = ageDays(p, asOf);
    var g = p.change_7d == null ? fill.growth : clamp(p.change_7d, -60, 150);
    return [Math.log(Math.max(p.tvl_usd, 1)), Math.log(1 + g / 100), Math.log(1 + (age == null ? fill.age : age) / 365.25)];
  }

  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return 0;
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function quantile(xs, q) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return 0;
    var pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  /** Solve A x = b by Gaussian elimination with partial pivoting (A is small and well conditioned). */
  function solve(A, b) {
    var n = b.length, M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      var t = M[c]; M[c] = M[piv]; M[piv] = t;
      for (var r2 = c + 1; r2 < n; r2++) {
        var f = M[r2][c] / M[c][c];
        for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k];
      }
    }
    var x = new Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (var j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /** Weighted ridge regression of y on centred X (intercept unpenalised). */
  function ridgeFit(X, y, w) {
    var d = X[0].length + 1, A = [], b = [];
    for (var i = 0; i < d; i++) { A.push(new Array(d).fill(0)); b.push(0); }
    for (var n = 0; n < y.length; n++) {
      var row = [1].concat(X[n]);
      for (var a = 0; a < d; a++) {
        b[a] += w[n] * row[a] * y[n];
        for (var c = 0; c < d; c++) A[a][c] += w[n] * row[a] * row[c];
      }
    }
    for (var k = 1; k < d; k++) A[k][k] += RIDGE;
    return solve(A, b);
  }

  /**
   * Fit the valuation on protocols whose token trades. `opts.featureMask` switches slopes off, which the
   * validation uses to show what each term adds; `opts.groups` false drops the family offsets.
   */
  function fit(live, asOf, opts) {
    opts = opts || {};
    var mask = opts.featureMask || [1, 0, 0]; // the core: TVL slope only, growth and age enter as priors
    var fill = {
      growth: median(live.filter(function (p) { return p.change_7d != null; }).map(function (p) { return clamp(p.change_7d, -60, 150); })),
      age: median(live.map(function (p) { return ageDays(p, asOf); }).filter(function (a) { return a != null; }))
    };
    var raw = live.map(function (p) { return rawFeatures(p, asOf, fill); });
    var centre = [0, 1, 2].map(function (j) { return raw.reduce(function (s, r) { return s + r[j]; }, 0) / raw.length; });
    var X = raw.map(function (r) { return r.map(function (v, j) { return (v - centre[j]) * mask[j]; }); });
    var y = live.map(function (p) { return Math.log(p.mcap_usd); });
    var w = y.map(function () { return 1; });
    var beta, resid;
    for (var it = 0; it < 4; it++) { // Huber reweighting: a few outliers do not drag the slopes
      beta = ridgeFit(X, y, w);
      resid = y.map(function (v, n) { return v - dot(beta, X[n]); });
      var scale = 1.4826 * median(resid.map(Math.abs)) || 1;
      w = resid.map(function (r) { var c = 1.345 * scale; return Math.abs(r) <= c ? 1 : c / Math.abs(r); });
    }
    var fam = opts.groups === false ? {} : shrunkMeans(live, resid, w, function (p) { return familyOf(p.category); }, FAMILY_PRIOR);
    var model = { id: MODEL_ID, asOf: asOf, beta: beta, centre: centre, mask: mask, fill: fill, family: fam, n: live.length, band: [-1, 1] };
    return model;
  }

  function dot(beta, x) { var s = beta[0]; for (var j = 0; j < x.length; j++) s += beta[j + 1] * x[j]; return s; }

  function shrunkMeans(rows, r, w, key, prior) {
    var sum = {}, wt = {}, out = {};
    rows.forEach(function (p, n) { var k = key(p); sum[k] = (sum[k] || 0) + w[n] * r[n]; wt[k] = (wt[k] || 0) + w[n]; });
    Object.keys(sum).forEach(function (k) { out[k] = sum[k] / (wt[k] + prior); });
    return out;
  }

  /** The log value and each term's share of it, for one protocol. */
  function predictLog(model, p) {
    var raw = rawFeatures(p, model.asOf, model.fill);
    var x = raw.map(function (v, j) { return (v - model.centre[j]) * model.mask[j]; });
    var fam = model.family[familyOf(p.category)] || 0;
    var terms = { base: model.beta[0], tvl: model.beta[1] * x[0], fitted: model.beta[2] * x[1] + model.beta[3] * x[2], family: fam };
    var core = terms.base + terms.tvl + terms.fitted + terms.family;
    if (model.priors === false) return { logV: core, terms: terms };
    terms.growth = growthPrior(p);
    terms.record = recordPrior(p, model.asOf);
    return { logV: core + terms.growth + terms.record, terms: terms };
  }

  /** ln of the growth factor: half of the snapshot week's clamped TVL move persists. */
  function growthPrior(p) {
    var g = p.change_7d == null ? 0 : clamp(p.change_7d, GROWTH_CLAMP[0], GROWTH_CLAMP[1]);
    return GROWTH_POWER * Math.log(1 + g / 100);
  }

  /** ln of the track-record factor: TVL held longer with no token is TVL that has proven it stays. */
  function recordPrior(p, asOf) {
    var age = ageDays(p, asOf);
    var years = age == null ? RECORD_YEARS / 2 : Math.min(age / 365.25, RECORD_YEARS);
    return Math.log(RECORD_FLOOR + (1 - RECORD_FLOOR) * years / RECORD_YEARS);
  }

  /** Implied value in whole dollars, with the held-out 80% band. */
  function value(model, p) {
    var r = predictLog(model, p);
    var v = Math.max(1, Math.round(Math.exp(r.logV)));
    return { implied: v, low: Math.max(1, Math.round(v * Math.exp(model.band[0]))), high: Math.round(v * Math.exp(model.band[1])),
      ratio: v / p.tvl_usd, terms: r.terms };
  }

  function spearman(a, b) {
    function ranks(xs) {
      var idx = xs.map(function (v, i) { return i; }).sort(function (i, j) { return xs[i] - xs[j]; });
      var r = new Array(xs.length);
      idx.forEach(function (i, k) { r[i] = k; });
      return r;
    }
    var ra = ranks(a), rb = ranks(b), n = a.length, d2 = 0;
    for (var i = 0; i < n; i++) d2 += (ra[i] - rb[i]) * (ra[i] - rb[i]);
    return 1 - 6 * d2 / (n * (n * n - 1));
  }

  /** k-fold held-out test on the live tokens, fold = position in slug order mod k. */
  function crossValidate(live, asOf, opts) {
    var sorted = live.slice().sort(function (a, b) { return a.slug < b.slug ? -1 : 1; });
    var errs = [], pred = [], act = [], rows = [];
    for (var f = 0; f < FOLDS; f++) {
      var train = sorted.filter(function (p, i) { return i % FOLDS !== f; });
      var test = sorted.filter(function (p, i) { return i % FOLDS === f; });
      var m = fit(train, asOf, opts);
      m.priors = !!(opts && opts.priors);
      test.forEach(function (p) {
        var lv = predictLog(m, p).logV, y = Math.log(p.mcap_usd);
        errs.push(y - lv); pred.push(lv); act.push(y);
        rows.push({ slug: p.slug, predicted: Math.round(Math.exp(lv)), actual: p.mcap_usd });
      });
    }
    var abs = errs.map(Math.abs);
    return { n: errs.length, medianMissX: Math.exp(median(abs)), rho: spearman(pred, act),
      within3x: abs.filter(function (e) { return e <= Math.log(3); }).length / abs.length,
      q10: quantile(errs, 0.1), q90: quantile(errs, 0.9), rows: rows };
  }

  /**
   * Walk-forward test: fit on the oldest 60% of live tokens by listing day, price the newest 40%. A
   * pre-token protocol is usually younger than the tokens that price it, so this is the harder blind test.
   */
  function walkForward(live, asOf, opts) {
    var dated = live.slice().sort(function (a, b) {
      var x = a.listed_at || '0000', y = b.listed_at || '0000';
      return x < y ? -1 : x > y ? 1 : (a.slug < b.slug ? -1 : 1);
    });
    var cut = Math.round(dated.length * 0.6);
    var m = fit(dated.slice(0, cut), asOf, opts);
    m.priors = !!(opts && opts.priors);
    var pred = [], act = [], abs = [];
    dated.slice(cut).forEach(function (p) {
      var lv = predictLog(m, p).logV, y = Math.log(p.mcap_usd);
      pred.push(lv); act.push(y); abs.push(Math.abs(y - lv));
    });
    return { n: abs.length, medianMissX: Math.exp(median(abs)), rho: spearman(pred, act), from: dated[cut].listed_at };
  }

  /** The validation table: the full model beside simpler ones, each tested on held-out tokens. */
  function validation(live, asOf) {
    var variants = [
      { key: 'tvl', label: 'TVL only', opts: { featureMask: [1, 0, 0], groups: false } },
      { key: 'core', label: 'TVL + family (the core)', opts: { featureMask: [1, 0, 0] } },
      { key: 'fitted', label: 'Core + growth and age fitted as slopes', opts: { featureMask: [1, 1, 1] } },
      { key: 'priors', label: 'Core + growth and track-record priors (used)', opts: { featureMask: [1, 0, 0], priors: true } }
    ];
    return variants.map(function (v) {
      var cv = crossValidate(live, asOf, v.opts), wf = walkForward(live, asOf, v.opts);
      return { key: v.key, label: v.label, medianMissX: cv.medianMissX, rho: cv.rho, within3x: cv.within3x, q10: cv.q10, q90: cv.q90,
        wfMissX: wf.medianMissX, wfRho: wf.rho, wfFrom: wf.from, wfN: wf.n, rows: v.key === 'priors' ? cv.rows : undefined };
    });
  }

  /**
   * Peer token rate: of the snapshot's protocols in the same family and of a similar age, the share that
   * already carries a token on record. Shrunk toward the whole snapshot's rate. It is no forecast of a
   * launch; it weights a farm plan's expected drop by how often protocols like this one have a token.
   */
  function peerRates(protocols, asOf) {
    var fam = {}, age = {}, all = { t: 0, n: 0 };
    function bucket(p) { var d = ageDays(p, asOf); return d == null ? 'unknown' : d < 365 ? '<1y' : d < 730 ? '1-2y' : d < 1461 ? '2-4y' : '4y+'; }
    protocols.forEach(function (p) {
      var has = tokenStatus(p) !== 'pre' ? 1 : 0, f = familyOf(p.category), b = bucket(p);
      fam[f] = fam[f] || { t: 0, n: 0 }; fam[f].t += has; fam[f].n++;
      age[b] = age[b] || { t: 0, n: 0 }; age[b].t += has; age[b].n++;
      all.t += has; all.n++;
    });
    var base = all.t / all.n;
    return {
      overall: base,
      family: fam, age: age,
      of: function (p) {
        var f = fam[familyOf(p.category)] || { t: 0, n: 0 }, a = age[bucket(p)] || { t: 0, n: 0 };
        var fr = (f.t + 6 * base) / (f.n + 6), ar = (a.t + 6 * base) / (a.n + 6);
        return clamp(fr * ar / base, 0.05, 0.95);
      },
      bucket: bucket
    };
  }

  function money(v) {
    var a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return s + '$' + Math.round(a / 1e3) + 'K';
    if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    if (a >= 100) return s + '$' + Math.round(a);
    return s + '$' + a.toFixed(2);
  }

  function niceDeposit(x) {
    var steps = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
    for (var i = 0; i < steps.length; i++) if (x <= steps[i]) return steps[i];
    return 50000;
  }

  // How each family is farmed: what to put in, how many transactions a full cycle takes, setup minutes.
  var PLAYBOOK = {
    'Yield & vaults': { asset: 'USDC', txs: 4, setup: 20, act: function (n) { return 'Deposit into ' + n + '’s main stablecoin vault (the largest one by deposits); vault shares usually accrue points per dollar per day, so size matters more than activity.'; } },
    'Credit & stablecoins': { asset: 'USDC', txs: 6, setup: 30, act: function (n) { return 'Supply USDC on ' + n + ', then borrow or mint at most 30% of it and keep the health factor above 2: credit protocols tend to reward both sides of the book, and the low loan-to-value keeps liquidation out of reach.'; } },
    'Trading': { asset: 'USDC + ETH', txs: 10, setup: 40, act: function (n) { return 'Split the deposit: two thirds as liquidity in ' + n + '’s deepest stable or blue-chip pool, one third as weekly trading volume; trading venues usually weigh fees paid and liquidity time, so spread activity over weeks, never one burst.'; } },
    'Real-world & payments': { asset: 'USDC', txs: 4, setup: 45, act: function (n) { return 'Pass ' + n + '’s onboarding (it may ask for KYC: allow a day), then buy and hold its tokenised product; real-world issuers reward held balance, and redemptions can take days, so only use money you can park.'; } },
    'Staking & BTC': { asset: 'the chain’s native asset', txs: 4, setup: 20, act: function (n) { return 'Stake the native asset through ' + n + ' and keep the receipt token in your own wallet (or in a lending market that lists it); staking products reward time-weighted balance, and a protocol built on a traded token may never issue one of its own.'; } },
    'Bridges': { asset: 'USDC', txs: 6, setup: 25, act: function (n) { return 'Bridge a working balance through ' + n + ' and back once or twice a month to two different chains; bridge drops have rewarded distinct months and routes more than raw volume, and each crossing pays fees on both sides.'; } },
    'Chains & infra': { asset: 'the chain’s native asset', txs: 8, setup: 40, act: function (n) { return 'Use ' + n + ' natively: hold the gas asset there, then make a swap, a deposit and a contract interaction each week; network drops weigh active weeks and breadth of use.'; } },
    'Other': { asset: 'USDC', txs: 5, setup: 30, act: function (n) { return 'Use ' + n + '’s main product with a modest balance and repeat the core action weekly; with no comparable playbook, breadth over weeks beats size in one day.'; } }
  };

  /** Main chain to farm on: the cheapest of the first three chains the protocol's TVL sits on. */
  function farmChain(p) {
    var cands = (p.chains || []).slice(0, 3);
    if (!cands.length) return { chain: 'its main chain', tx: TX_DEFAULT };
    var best = cands[0];
    cands.forEach(function (c) { if ((TX_COST[c] != null ? TX_COST[c] : TX_DEFAULT) < (TX_COST[best] != null ? TX_COST[best] : TX_DEFAULT)) best = c; });
    return { chain: best, tx: TX_COST[best] != null ? TX_COST[best] : TX_DEFAULT };
  }

  /** A farm plan with what it costs and how long it takes, worked out from the row's own numbers. */
  function farmPlan(p, v, asOf, odds) {
    if (odds == null) odds = 0.5;
    var fam = familyOf(p.category), book = PLAYBOOK[fam] || PLAYBOOK.Other;
    var age = ageDays(p, asOf);
    var hold = age == null ? 90 : age < 180 ? 60 : age < 730 ? 90 : 120;
    var ch = farmChain(p);
    var native = NATIVE[ch.chain];
    var asset = book.asset;
    if (book.asset.indexOf('native') >= 0) asset = native || 'ETH';
    else if (native === 'SOL') asset = book.asset.replace('ETH', 'SOL');
    else if (native === 'USDT' || native === 'USDC') asset = native;
    else if (native) asset = native;
    var cycleCost = ch.tx * (book.txs + 2); // + funding hop and the claim
    var per1k = v.implied * AIRDROP_SHARE * 1000 / p.tvl_usd;
    var apr = per1k / 1000 * 365 / hold;
    var deposit = niceDeposit(cycleCost / (0.05 * per1k / 1000)); // fees at most 5% of the expected drop
    var expected = per1k * deposit / 1000;
    var g = p.change_7d == null ? 0 : p.change_7d;
    // Weighted by how often peers carry a token, net of every fee: is the plan worth running at all?
    var aprAdj = apr * odds, net = expected * odds - cycleCost;
    var verdict = aprAdj >= 0.03 && net > 0 ? 'Farm' : aprAdj >= 0.01 && net > 0 ? 'Thin' : 'Skip';
    var why = verdict === 'Farm' ? 'the drop is worth more than the fees and the capital’s time' :
      verdict === 'Thin' ? 'worth it only if you would hold this position anyway' : 'the drop per dollar is too diluted by its TVL to beat fees and a plain yield';
    var steps = [
      'Verdict: ' + verdict + ' (' + (aprAdj * 100).toFixed(1) + '% a year after weighting by the ' + Math.round(odds * 100) + '% peer token rate; ' + money(net) + ' net on ' + money(deposit) + ' after ' + money(cycleCost) + ' of fees): ' + why + '.',
      'Check first (5 min): confirm on ' + p.name + '’s own site that it still has no token and that a points or rewards programme is live. The snapshot (' + asOf + ') records no token; if one has launched, skip the plan.',
      'Fund (' + Math.round(book.setup / 2) + ' min, about ' + money(ch.tx * 2) + '): move ' + money(deposit) + ' of ' + asset + ' to ' + ch.chain + '. That size keeps the whole cycle’s fees (' + money(cycleCost) + ' for ' + (book.txs + 2) + ' transactions at ~' + money(ch.tx) + ' each) under 5% of the expected drop.',
      'Position (' + Math.round(book.setup / 2) + ' min, about ' + money(ch.tx * book.txs / 2) + '): ' + book.act(p.name),
      'Hold ' + hold + ' days, checking weekly (5 min): at the model’s ' + (AIRDROP_SHARE * 100) + '% user share of a ' + money(v.implied) + ' launch, every $1,000 kept in all season earns about ' + money(per1k) + ', near ' + (apr * 100).toFixed(1) + '% a year on top of the base yield; ' + money(deposit) + ' expects about ' + money(expected) + '.',
      'Exit rule: withdraw if TVL drops more than 25% in a week (it moved ' + (g >= 0 ? '+' : '') + g.toFixed(1) + '% in the snapshot week), if the protocol pauses withdrawals, or if a token launches with no user allocation. Leaving costs about ' + money(ch.tx * 2) + '.',
      'After a launch: claim inside the claim window (one transaction, ~' + money(ch.tx) + '), and judge the price against the implied ' + money(v.implied) + ' (band ' + money(v.low) + ' to ' + money(v.high) + ') before you sell or keep.'
    ];
    return { steps: steps, chain: ch.chain, txCost: ch.tx, cycleCost: cycleCost, setupMin: book.setup + 5, holdDays: hold,
      per1k: per1k, apr: apr, deposit: deposit, expected: expected, asset: asset, family: fam,
      odds: odds, aprAdj: aprAdj, net: net, verdict: verdict };
  }

  /** The whole radar from a snapshot: the fit, its validation, the ranked board and the set-aside lists. */
  function buildRadar(snapshot) {
    var asOf = snapshot.as_of, watch = {};
    snapshot.watchlist.forEach(function (s) { watch[s] = true; });
    var live = [], recorded = [], pre = [], aside = [];
    snapshot.protocols.forEach(function (p) {
      var st = tokenStatus(p);
      if (st === 'live') live.push(p);
      else if (st === 'recorded') recorded.push(p);
      else if (setAsideReason(p) && !watch[p.slug]) aside.push(p);
      else pre.push(p);
    });
    var checks = validation(live, asOf);
    var used = checks[checks.length - 1];
    var model = fit(live, asOf);
    model.band = [used.q10, used.q90];
    var rows = pre.map(function (p) {
      var v = value(model, p);
      return { p: p, v: v };
    }).sort(function (a, b) { return b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : 1); });
    var peers = peerRates(snapshot.protocols, asOf);
    var board = rows.map(function (r, i) {
      var plan = farmPlan(r.p, r.v, asOf, peers.of(r.p));
      return { slug: r.p.slug, name: r.p.name, rank: i + 1, implied_value_usd: r.v.implied,
        implied_low_usd: r.v.low, implied_high_usd: r.v.high, category: r.p.category, family: plan.family,
        chains: r.p.chains, tvl_usd: r.p.tvl_usd, change_7d: r.p.change_7d, listed_at: r.p.listed_at,
        days_without_token: ageDays(r.p, asOf), watchlist: !!watch[r.p.slug], token_status: 'none recorded',
        // At or above the floor, passing every name and category test, yet off the watchlist: the only
        // test left is DefiLlama's parent link, so a parent protocol may already carry the token.
        parent_linked: !watch[r.p.slug] && r.p.tvl_usd >= snapshot.floor_usd,
        value_to_tvl: Math.round(r.v.ratio * 1000) / 1000,
        terms: roundTerms(r.v.terms),
        farm: { chain: plan.chain, deposit_usd: plan.deposit, cycle_cost_usd: Math.round(plan.cycleCost * 100) / 100,
          setup_minutes: plan.setupMin, hold_days: plan.holdDays, per_1k_usd: Math.round(plan.per1k * 100) / 100,
          apr_equivalent: Math.round(plan.apr * 10000) / 10000, expected_usd: Math.round(plan.expected),
          peer_token_rate: Math.round(plan.odds * 1000) / 1000, risk_adjusted_apr: Math.round(plan.aprAdj * 10000) / 10000,
          net_usd: Math.round(plan.net), verdict: plan.verdict },
        farm_steps: plan.steps };
    });
    return { model: model, validation: checks, board: board, live: live, recorded: recorded, aside: aside, peers: peers };
  }

  function roundTerms(t) {
    var o = {};
    Object.keys(t).forEach(function (k) { o[k] = Math.round(t[k] * 10000) / 10000; });
    return o;
  }

  root.RadarModel = { MODEL_ID: MODEL_ID, AIRDROP_SHARE: AIRDROP_SHARE, TX_COST: TX_COST, FAMILY: FAMILY,
    familyOf: familyOf, tokenStatus: tokenStatus, setAsideReason: setAsideReason, ageDays: ageDays,
    fit: fit, value: value, predictLog: predictLog, validation: validation, farmPlan: farmPlan, peerRates: peerRates,
    buildRadar: buildRadar, money: money };
})(typeof globalThis !== 'undefined' ? globalThis : this);
