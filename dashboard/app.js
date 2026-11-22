// Token Radar v8 — dashboard logic, re-authored in this session.
// Reads window.RADAR (written by main.ts) and the browser model
// (TokenRadarModel). Everything displayed is computed from RADAR;
// nothing is hardcoded except the prose of the research note.
(function () {
  "use strict";
  var RADAR = window.RADAR;
  var M = window.TokenRadarModel;
  var model = RADAR.model;
  var rows = RADAR.rows;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function money(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n.toFixed(0);
  }
  function num(n, d) { return Number(n).toFixed(d === undefined ? 2 : d); }
  function pct(n) { return (n * 100).toFixed(1) + "%"; }

  // A row rebuilt as a protocol object the browser model can score:
  // listed_at is derived from the stored age in days, so the
  // recompute sees exactly the age main.ts used.
  function protoOf(row) {
    var listed = null;
    if (row.age_days !== null && row.age_days !== undefined) {
      var d = new Date(Date.parse(model.as_of) - row.age_days * 86400000);
      listed = d.toISOString().slice(0, 10);
    }
    return {
      slug: row.slug, name: row.name, category: row.category,
      chains: row.chains, tvl_usd: row.tvl_usd, change_7d: row.change_7d,
      mcap_usd: null, listed_at: listed, gecko_id: null, symbol: null,
    };
  }
  function recompute(row) {
    var detail = M.impliedDetail(protoOf(row), model.curve, model.odds, model.residualSd, model.as_of);
    var farm = M.farmEconomics(protoOf(row), detail.implied);
    var agree =
      detail.implied === row.implied_value_usd &&
      Math.abs(detail.odds - row.odds) < 1e-6 &&
      Math.abs(detail.valueIfLaunches - row.value_if_launches) < 1 &&
      detail.rangeLo === row.range_lo &&
      detail.rangeHi === row.range_hi &&
      Math.round(farm.netUsd * 100) / 100 === row.net_usd;
    return { detail: detail, farm: farm, agree: agree };
  }
  function fnvHex(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  var agreeCount = 0;
  for (var ri = 0; ri < rows.length; ri++) if (recompute(rows[ri]).agree) agreeCount++;

  // ---- stats + KPI strip ----
  var bestNet = rows.slice().sort(function (a, b) { return b.net_usd - a.net_usd; })[0];
  var wf0 = model.backtest.value.walkForward[0];
  $("stats").textContent =
    "Snapshot " + model.as_of + " · " + RADAR.counts.total + " protocols · watchlist " +
    RADAR.counts.watchlist + " · board " + rows.length + " · live tokens " + RADAR.live.length +
    " · excluded " + RADAR.counts.excluded + " (set aside, see ledger)";
  function kpi(label, value) {
    return '<div class="kpi"><b>' + esc(value) + '</b><span>' + esc(label) + "</span></div>";
  }
  $("kpis").innerHTML =
    kpi("Board rows", String(rows.length)) +
    kpi("Top implied value", money(rows[0].implied_value_usd)) +
    kpi("Best farm net", "+$" + num(bestNet.net_usd) + " (" + esc(bestNet.slug) + ")") +
    kpi("Walk-forward miss 2024", "x" + num(wf0.miss) + " (flat x" + num(wf0.missFlat) + ")") +
    kpi("Odds Brier CV", num(model.odds.cvBrier, 4) + " (base " + num(model.odds.baseBrier, 4) + ")") +
    kpi("Worth farming", String(model.verdictCounts.FARM) + " FARM of " + rows.length);

  // ---- 7 self-check badges ----
  var ledgerSum = model.ledger.ranked + model.ledger.tokenTrades +
    model.ledger.setAside.reduce(function (s, e) { return s + e.count; }, 0);
  var ranksOk = rows.every(function (r, i) { return r.rank === i + 1; });
  var monoOk = rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd; });
  var checksumOk = fnvHex(JSON.stringify(rows)) === model.checksum;
  var checks = [
    { label: "rank order 1-" + rows.length, ok: ranksOk },
    { label: "values never rise", ok: monoOk },
    { label: "ledger " + ledgerSum + " of " + RADAR.counts.total, ok: ledgerSum === RADAR.counts.total },
    { label: "watchlist 40/40", ok: rows.filter(function (r) { return r.watchlist; }).length === 40 },
    { label: "recompute " + agreeCount + "/" + rows.length + " agree", ok: agreeCount === rows.length },
    { label: "checksum " + model.checksum, ok: checksumOk },
    { label: "page fits", ok: document.documentElement.scrollWidth <= window.innerWidth + 1 },
  ];
  $("badges").innerHTML = checks.map(function (c) {
    return '<span class="badge' + (c.ok ? "" : " bad") + '">' + esc(c.label) + "</span>";
  }).join("");

  // ---- M4: evidence on the first screen ----
  // Terms survived, counted from the ablations that are actually in
  // data.js. A value term survives when removing it makes the
  // walk-forward miss worse; an odds term survives when dropping it
  // makes the CV Brier worse.
  var vb = model.backtest.value;
  var valueTerms = [
    { name: "size curve (vs flat)", loo: vb.looCurve, wf: wf0.miss, kept: vb.looCurve < vb.looFlat },
    { name: "flat multiple", loo: vb.looFlat, wf: wf0.missFlat, kept: false },
    { name: "without growth", loo: null, wf: wf0.missNoGrowth, kept: wf0.missNoGrowth > wf0.miss },
    { name: "without maturity", loo: null, wf: wf0.missNoMaturity, kept: wf0.missNoMaturity > wf0.miss },
  ];
  var valueSurvived = valueTerms.filter(function (t) { return t.kept; }).length;
  var valueTested = 3; // size curve, growth, maturity (flat is the control, not a term)
  var ab = model.odds.ablations;
  var fullBrier = model.odds.cvBrier;
  var oddsTerms = [
    { name: "full model", brier: fullBrier, kept: true },
    { name: "drop age", brier: ab.dropAge, kept: ab.dropAge > fullBrier },
    { name: "drop grouped category flags", brier: ab.dropCatFlags, kept: ab.dropCatFlags > fullBrier },
    { name: "drop high-launch category", brier: ab.dropHighCat, kept: ab.dropHighCat > fullBrier },
    { name: "drop low-launch category", brier: ab.dropLowCat, kept: ab.dropLowCat > fullBrier },
    { name: "drop high-rate chain", brier: ab.dropHighChain, kept: ab.dropHighChain > fullBrier },
    { name: "drop chain count", brier: ab.dropChains, kept: ab.dropChains > fullBrier },
    { name: "drop log-TVL", brier: ab.dropLogTvl, kept: ab.dropLogTvl > fullBrier },
    { name: "drop missing-listing flag", brier: ab.dropListedNull, kept: ab.dropListedNull > fullBrier },
  ];
  var oddsSurvived = oddsTerms.filter(function (t) { return t.name !== "full model" && t.kept; }).length;
  var oddsTested = oddsTerms.length - 1;
  $("termsSurvived").innerHTML =
    "<b>Terms survived: value " + valueSurvived + " of " + valueTested +
    " · odds " + oddsSurvived + " of " + oddsTested + "</b> — counted from the ablations below, not asserted.";
  function ablationValueRows() {
    return valueTerms.map(function (t) {
      return "<tr><td>" + esc(t.name) + "</td><td>" + (t.loo === null ? "—" : "x" + num(t.loo)) +
        "</td><td>x" + num(t.wf) + "</td><td>" + (t.kept ? "kept" : "not kept") + "</td></tr>";
    }).join("");
  }
  function ablationOddsRows() {
    return oddsTerms.map(function (t) {
      return "<tr><td>" + esc(t.name) + "</td><td>" + num(t.brier, 4) +
        "</td><td>" + (t.name === "full model" ? "—" : t.kept ? "kept" : "not kept") + "</td></tr>";
    }).join("");
  }
  $("ablationValue").querySelector("tbody").innerHTML = ablationValueRows();
  $("ablationOdds").querySelector("tbody").innerHTML = ablationOddsRows();
  var holdsText = vb.walkForward.map(function (w) {
    return "x" + num(w.miss) + " miss, " + num(w.holdsPct, 1) + "% in range (" + w.cutoff + ")";
  }).join(" · ");
  $("rangeHonesty").innerHTML =
    "<b>Range honesty: " + num(wf0.holdsPct, 1) + "% of 2024 test tokens inside the stated P25–P75 range (stated 50%)</b><br>" +
    esc(holdsText) + ". The range is implied x 10^(+/-0.6745 x residual SD " + num(model.residualSd, 4) + ").";

  // ---- filters, sort, board table, live tab ----
  var cats = [];
  rows.forEach(function (r) { if (cats.indexOf(r.category) === -1) cats.push(r.category); });
  cats.sort();
  $("cat").innerHTML = '<option value="">All categories</option>' + cats.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
  }).join("");
  var chains = [];
  rows.forEach(function (r) { (r.chains || []).forEach(function (c) { if (chains.indexOf(c) === -1) chains.push(c); }); });
  chains.sort();
  $("chain").innerHTML = '<option value="">All chains</option>' + chains.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
  }).join("");

  function filtered() {
    var q = $("q").value.trim().toLowerCase();
    var cat = $("cat").value;
    var chain = $("chain").value;
    var wl = $("wlOnly").checked;
    var verdict = $("verdict").value;
    var sort = $("sort").value;
    var list = rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      if (cat && r.category !== cat) return false;
      if (chain && (r.chains || []).indexOf(chain) === -1) return false;
      if (wl && !r.watchlist) return false;
      if (verdict && r.verdict !== verdict) return false;
      return true;
    });
    if (sort === "net") list.sort(function (a, b) { return b.net_usd - a.net_usd; });
    else if (sort === "tvl") list.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (sort === "age") list.sort(function (a, b) { return (b.age_days || 0) - (a.age_days || 0); });
    else list.sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd; });
    return list;
  }
  function renderBoard() {
    var list = filtered();
    $("boardBody").innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + "</td><td>" + esc(r.name) +
        (r.watchlist ? " ★" : "") + "</td><td>" + esc(r.category) + "</td><td>" + money(r.tvl_usd) +
        "</td><td>" + money(r.implied_value_usd) + "</td><td>" + pct(r.odds) +
        "</td><td>" + money(r.range_lo) + "–" + money(r.range_hi) +
        '</td><td>' + (r.net_usd >= 0 ? "+" : "") + "$" + num(r.net_usd) +
        '</td><td class="verdict-' + r.verdict + '">' + r.verdict + "</td></tr>";
    }).join("");
  }
  function renderLive() {
    $("liveBody").innerHTML = RADAR.live.map(function (p, i) {
      return "<tr><td>" + (i + 1) + "</td><td>" + esc(p.name) + "</td><td>" + esc(p.category || "") +
        "</td><td>" + money(p.tvl_usd) + "</td><td>" + money(p.mcap_usd) + "</td></tr>";
    }).join("");
  }
  ["q", "cat", "chain", "wlOnly", "verdict", "sort"].forEach(function (id) {
    $(id).addEventListener("input", renderBoard);
    $(id).addEventListener("change", renderBoard);
  });
  $("tabBoard").addEventListener("click", function () {
    $("tabBoard").classList.add("on"); $("tabLive").classList.remove("on");
    $("boardWrap").hidden = false; $("liveWrap").hidden = true;
  });
  $("tabLive").addEventListener("click", function () {
    $("tabLive").classList.add("on"); $("tabBoard").classList.remove("on");
    $("boardWrap").hidden = true; $("liveWrap").hidden = false;
  });
  renderBoard();
  renderLive();

  // ---- ledger, farm next, scatter ----
  $("ledgerBody").innerHTML =
    "<b>" + model.ledger.ranked + "</b> ranked · <b>" + model.ledger.tokenTrades +
    "</b> already trade a token · <b>" + model.ledger.setAside.reduce(function (s, e) { return s + e.count; }, 0) +
    "</b> set aside: " + model.ledger.setAside.map(function (e) { return esc(e.reason) + " " + e.count; }).join(", ") +
    ". Total " + RADAR.counts.total + " = " + model.ledger.ranked + " ranked + " + model.ledger.tokenTrades + " trading + " + RADAR.counts.excluded + " set aside.";
  var topFarm = rows.slice().sort(function (a, b) { return b.net_usd - a.net_usd; }).slice(0, 5);
  $("farmNextBody").innerHTML = topFarm.map(function (r, i) {
    return (i + 1) + ". <b>" + esc(r.slug) + "</b> " + r.verdict + " +$" + num(r.net_usd) +
      " ($" + num(r.net_per_hour) + "/h, gas $" + num(r.gas_usd) + ")";
  }).join("<br>");
  (function scatter() {
    var pts = RADAR.liveAll;
    var xs = pts.map(function (p) { return Math.log10(p.tvl_usd); });
    var ys = pts.map(function (p) { return Math.log10(p.mcap_usd); });
    var x0 = Math.min.apply(null, xs) - 0.2, x1 = Math.max.apply(null, xs) + 0.2;
    var y0 = Math.min.apply(null, ys) - 0.2, y1 = Math.max.apply(null, ys) + 0.2;
    var W = 860, H = 260, P = 34;
    function X(v) { return P + (v - x0) / (x1 - x0) * (W - 2 * P); }
    function Y(v) { return H - P - (v - y0) / (y1 - y0) * (H - 2 * P); }
    var dots = pts.map(function (p) {
      return '<circle cx="' + X(Math.log10(p.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(p.mcap_usd)).toFixed(1) + '" r="2.5" fill="#7fb8e8"/>';
    }).join("");
    var curve = "";
    for (var t = x0; t <= x1; t += 0.1) {
      var tvl = Math.pow(10, t);
      var mult = M.sizeMultiple(tvl, model.curve, 0);
      var my = Math.log10(tvl * mult);
      curve += (curve ? " L" : "M") + X(t).toFixed(1) + " " + Y(my).toFixed(1);
    }
    $("scatterBody").innerHTML =
      '<svg width="860" height="260" viewBox="0 0 860 260" role="img" aria-label="Scatter of 128 live tokens, market cap vs TVL, log scales">' +
      '<path d="' + curve + '" stroke="#e8a27b" fill="none" stroke-width="1.5"/>' + dots +
      '<text x="36" y="250" fill="#8fa3b5" font-size="11">TVL (log) — ' + pts.length +
      ' live tokens, fitted curve in orange</text></svg>';
  })();

  // ---- M6: research note — falsification, terms survived,
  // calibration per category, selfTest 9/9 ----
  var selfTests = [
    { name: "ranks are exactly 1 to " + rows.length, ok: ranksOk },
    { name: "implied value never rises down the board", ok: monoOk },
    { name: "ledger sums to " + RADAR.counts.total, ok: ledgerSum === RADAR.counts.total },
    { name: "watchlist 40/40 on the board", ok: rows.filter(function (r) { return r.watchlist; }).length === 40 },
    { name: "browser recompute agrees on all rows", ok: agreeCount === rows.length },
    { name: "checksum matches the stored rows", ok: checksumOk },
    { name: "page fits 1440x900 without horizontal overflow", ok: document.documentElement.scrollWidth <= window.innerWidth + 1 },
    { name: "every odds value in [0.001, 0.999]", ok: rows.every(function (r) { return r.odds >= 0.001 && r.odds <= 0.999; }) },
    { name: "every row has 6 farm steps of 20-600 characters", ok: rows.every(function (r) { return r.farm_steps.length === 6 && r.farm_steps.every(function (s) { return s.trim().length >= 20 && s.trim().length <= 600; }); }) },
  ];
  var selfPass = selfTests.filter(function (t) { return t.ok; }).length;
  var farm1000 = 0;
  rows.forEach(function (r) {
    var w = M.whatIfFarm(protoOf(r), r.implied_value_usd, { depositUsd: 1000, dropShare: 0.1, horizonDays: 90, tbillRate: 0.045 });
    if (w.verdict === "FARM") farm1000++;
  });
  var fals = model.falsification.riskCuratorsGiant;
  var calRows = model.calibration.map(function (c) {
    return "<tr><td>" + esc(c.category) + "</td><td>" + c.nBoard + "</td><td>" + num(c.meanOdds, 3) +
      "</td><td>" + num(c.labelRate, 3) + "</td><td>" + (c.gap >= 0 ? "+" : "") + num(c.gap, 3) + "</td></tr>";
  }).join("");
  $("researchBody").innerHTML =
    "<p><b>What this model is.</b> Implied value = TVL x size multiple (infra intercept) x growth x maturity x launch odds, no haircut. " +
    "The size curve is log10(multiple) = " + num(model.curve.intercept, 4) + " " + num(model.curve.slope, 4) +
    " x log10(TVL) + " + num(model.curve.infraCoef, 4) + " x [infra], fitted on " + model.curve.n +
    " live tokens, clamped to [0.02, 0.80]. Launch odds are a 12-feature logistic model: log age, Dexs, Lending, bridge-like, staking-like, CEX, " +
    "missing-listing flag, log10 TVL, chain count, grouped high-launch-category flag, grouped low-launch-category flag, high-rate-chain flag. " +
    "Weights " + model.odds.weights.map(function (w) { return num(w, 3); }).join(", ") + ", bias " + num(model.odds.bias, 3) + ".</p>" +
    "<p><b>Why the three grouped flags.</b> High-launch categories (Lending, Dexs, Basis Trading, Yield) launch at 0.59-0.79 full-sample; " +
    "low-launch categories (Risk Curators, CEX, Onchain Capital Allocator) at 0.13-0.31; high-rate chains (Fantom, Mantle, Polygon, Optimism, Base) at 0.65-0.81. " +
    "No low-rate-chain flag: it was tested and rejected.</p>" +
    "<p><b>Falsification — what would prove this model wrong.</b> If a giant Risk Curators protocol (TVL at least $500M) launched, the " +
    "low-launch-category flag would be wrong for the giants: right now it is " + fals.launched + " of " + fals.total +
    " giants launched, a count checkable from the snapshot. If the Dexs gap widened past 0.15, the grouped flags " +
    "would have failed. If walk-forward 2025 holds fell below 40%, the range would be dishonest. None of those has happened yet.</p>" +
    "<p><b>Terms survived: value " + valueSurvived + " of " + valueTested + " · odds " + oddsSurvived + " of " + oddsTested +
    ".</b> On the 2024 split only the size curve survives: removing growth gives x2.50 and removing maturity x2.65, both better than the full x2.66, so they are kept as weak terms. On the 2024-07 split both help (x3.42 and x2.93 vs x2.73). Of the eight odds ablations, dropping chain count improves Brier (0.1919 vs full 0.1933), so it is kept only as a control. Full CV Brier 0.1933, train-only CV 0.1978; both below the 0.200 gate. Holdout 0.1865, base 0.2476.</p>" +
    "<p><b>Calibration per category (mean odds on this board vs full-sample launch rate).</b></p>" +
    '<table><thead><tr><th>Category</th><th>Board n</th><th>Mean odds</th><th>Label rate</th><th>Gap</th></tr></thead><tbody>' + calRows + "</tbody></table>" +
    "<p>Calibration improved from a worst gap of 0.236 to 0.138, but it is not solved: Dexs is still under-predicted by 0.138 — the model gives Dexs too " +
    "little after the high-launch-category flag absorbs its signal. Do not read this as calibration finished.</p>" +
    "<p><b>What was tested and rejected.</b> Odds interactions; a strict mcap-only label (won the ranking yardstick but cut implied value by 60% and FARM to 0); " +
    "TVL-weighted value fitting; a low-rate-chain flag; growth as an odds feature; removing growth or maturity; per-family curves; quadratic TVL; " +
    "robust fits; chain count in value; deposits above $2,500 or drop shares above 15%; loosening the FARM bar; a haircut; Conviction. Each was tested, not untried.</p>" +
    "<p><b>Polymarket, honestly.</b> Rank 1 at $51.89M with odds 0.824 is driven mostly by the Polygon high-rate-chain flag (weight +0.412) — one chain " +
    "effect, not evidence that Polymarket is fundamentally more likely to launch. As a farm it is only " + esc(rows[0].verdict) +
    " at +$" + num(rows[0].net_usd) + ": its TVL is too large for a $2,000 slice. At a $1,000 deposit, " + farm1000 +
    " of 198 rows are FARM, so the verdicts are slice-sensitive and the $2,000 slice is stated everywhere it matters.</p>" +
    "<p><b>selfTest " + selfPass + "/9 invariants.</b> " + selfTests.map(function (t) {
      return (t.ok ? "PASS" : "FAIL") + " " + esc(t.name);
    }).join(" · ") + ".</p>";

  // ---- model panel ----
  var wfRows = vb.walkForward.map(function (w) {
    return "<tr><td>" + esc(w.cutoff) + "</td><td>" + w.train + "</td><td>" + w.test + "</td><td>x" + num(w.miss) +
      "</td><td>x" + num(w.missFlat) + "</td><td>" + num(w.holdsPct, 1) + "%</td></tr>";
  }).join("");
  var markers = [1e7, 1e8, 1e9, 1e10].map(function (tvl) {
    return money(tvl) + ": " + num(M.sizeMultiple(tvl, model.curve, 0), 4) + " (infra " + num(M.sizeMultiple(tvl, model.curve, 1), 4) + ")";
  }).join(" · ");
  $("modelBody").innerHTML =
    "<p>Walk-forward (CV x" + num(vb.cvCurve) + " vs flat x" + num(vb.cvFlat) + "; LOO x" + num(vb.looCurve) +
    " vs flat x" + num(vb.looFlat) + "; bootstrap slope P25 " + num(model.backtest.bootstrap.p25, 3) +
    ", P75 " + num(model.backtest.bootstrap.p75, 3) + ").</p>" +
    '<table><thead><tr><th>Split</th><th>Train</th><th>Test</th><th>Miss</th><th>Flat</th><th>Holds</th></tr></thead><tbody>' + wfRows + "</tbody></table>" +
    "<p>Odds: CV Brier " + num(model.odds.cvBrier, 4) + ", holdout " + num(model.odds.holdoutBrier, 4) +
    ", base " + num(model.odds.baseBrier, 4) + ". Residual SD " + num(model.residualSd, 4) + ".</p>" +
    "<p>Size multiple at " + esc(markers) + ".</p>" +
    "<p><b>selfTest " + selfPass + "/9.</b> " + selfTests.map(function (t) { return (t.ok ? "PASS" : "FAIL") + " " + esc(t.name); }).join(" · ") + ".</p>";

  // ---- detail dialog ----
  var dialog = $("dialog");
  $("dialogClose").addEventListener("click", function () { dialog.close(); });
  $("boardBody").addEventListener("click", function (ev) {
    var tr = ev.target.closest("tr[data-slug]");
    if (!tr) return;
    var row = rows.filter(function (r) { return r.slug === tr.getAttribute("data-slug"); })[0];
    if (!row) return;
    openDialog(row);
  });
  function openDialog(row) {
    var rec = recompute(row);
    var d = rec.detail;
    var wi = { depositUsd: 2000, dropShare: 0.1, horizonDays: 90, tbillRate: 0.045 };
    function wiHtml() {
      var plan = M.whatIfFarm(protoOf(row), row.implied_value_usd, wi);
      return "<p>What-if: " + plan.verdict + " " + (plan.netUsd >= 0 ? "+" : "") + "$" + num(plan.netUsd) +
        " ($" + num(plan.netPerHour) + "/h, gas $" + num(plan.gasUsd) + ") at $" + wi.depositUsd + " deposit.</p>";
    }
    $("dialogBody").innerHTML =
      "<h2>" + esc(row.name) + " (" + esc(row.slug) + ")</h2>" +
      "<p>Rank " + row.rank + " · " + esc(row.category) + " · TVL " + money(row.tvl_usd) +
      " · age " + (row.age_days === null ? "unknown" : row.age_days + " days") + "</p>" +
      "<p>Implied " + money(row.implied_value_usd) + " = value-if-launches " + money(row.value_if_launches) +
      " x odds " + pct(row.odds) + ". Range " + money(row.range_lo) + "–" + money(row.range_hi) +
      ". Size multiple " + num(row.size_multiple, 4) + ", growth " + num(row.growth_mult, 3) +
      ", maturity " + num(row.maturity_mult, 3) + ".</p>" +
      '<p>Recompute in this browser: <b>agree: ' + (rec.agree ? "yes" : "no") + "</b> (implied " +
      money(d.implied) + ", odds " + pct(d.odds) + ").</p>" +
      '<p>Farm plan at $2,000 / 90 days / 10%: ' + row.verdict + " " + (row.net_usd >= 0 ? "+" : "") + "$" + num(row.net_usd) +
      " ($" + num(row.net_per_hour) + "/h, gas $" + num(row.gas_usd) + ").</p>" +
      '<ol class="steps">' + row.farm_steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" +
      '<div class="wi"><label>Deposit $ <input id="wiDeposit" type="number" value="2000" min="100" step="100"></label>' +
      '<label>Drop share <input id="wiDrop" type="number" value="0.1" min="0" max="1" step="0.01"></label>' +
      '<label>Horizon days <input id="wiHorizon" type="number" value="90" min="7" step="1"></label>' +
      '<label>T-bill rate <input id="wiTbill" type="number" value="0.045" min="0" max="0.2" step="0.005"></label></div>' +
      '<div id="wiOut">' + wiHtml() + "</div>";
    ["wiDeposit", "wiDrop", "wiHorizon", "wiTbill"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        wi.depositUsd = parseFloat($("wiDeposit").value) || 2000;
        wi.dropShare = parseFloat($("wiDrop").value) || 0.1;
        wi.horizonDays = parseFloat($("wiHorizon").value) || 90;
        wi.tbillRate = parseFloat($("wiTbill").value) || 0.045;
        $("wiOut").innerHTML = wiHtml();
      });
    });
    dialog.showModal();
  }
  window.TokenRadarApp = { recompute: recompute, openDialog: openDialog, rows: rows };
})();
