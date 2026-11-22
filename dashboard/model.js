(function () {
  "use strict";

  function median(values) {
    var clean = (values || []).filter(function (v) { return typeof v === "number" && isFinite(v); });
    if (!clean.length) return 0;
    clean.sort(function (a, b) { return a - b; });
    var mid = Math.floor(clean.length / 2);
    if (clean.length % 2) return clean[mid];
    return (clean[mid - 1] + clean[mid]) / 2;
  }

  function mulberry32(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function toTime(value) {
    if (value instanceof Date) {
      var t = value.getTime();
      return isFinite(t) ? t : null;
    }
    if (typeof value === "string") {
      var p = Date.parse(value);
      return isFinite(p) ? p : null;
    }
    return null;
  }

  function ageDays(asOf, listedAt) {
    if (listedAt === null || listedAt === undefined) return null;
    var a = toTime(asOf);
    var l = toTime(listedAt);
    if (a === null || l === null) return null;
    var d = Math.floor((a - l) / 86400000);
    return d < 0 ? 0 : d;
  }

  function isInfra(category) {
    return category === "Chain" || category === "CEX" || category === "Bridge" ||
      category === "Canonical Bridge" || category === "Prediction Market" ||
      category === "CeDeFi" || category === "Governance Incentives" ? 1 : 0;
  }

  // log10(mcap/TVL) = a + b*log10(TVL) + c*[infra], fitted by OLS
  // through the 3x3 normal equations (Gaussian elimination, partial
  // pivoting). Fallback is the pooled fit from the full snapshot.
  function fitSizeCurve(liveProtocols) {
    var list = liveProtocols || [];
    var xs = [], infs = [], ys = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      var tvl = p.tvl_usd, mcap = p.mcap_usd;
      if (typeof tvl !== "number" || typeof mcap !== "number") continue;
      if (!isFinite(tvl) || !isFinite(mcap) || tvl <= 0 || mcap <= 0) continue;
      var x = Math.log(tvl) / Math.LN10, y = Math.log(mcap / tvl) / Math.LN10;
      if (!isFinite(x) || !isFinite(y)) continue;
      xs.push(x); infs.push(isInfra(p.category)); ys.push(y);
    }
    var n = xs.length;
    if (n < 10) return { intercept: 3.3114, slope: -0.5269, infraCoef: 0.4686, n: n, clampMin: 0.02, clampMax: 0.8 };
    var sx = 0, si = 0, sxx = 0, sxi = 0, sii = 0, sy = 0, sxy = 0, siy = 0;
    for (var k = 0; k < n; k++) {
      sx += xs[k]; si += infs[k]; sxx += xs[k] * xs[k]; sxi += xs[k] * infs[k];
      sii += infs[k] * infs[k]; sy += ys[k]; sxy += xs[k] * ys[k]; siy += infs[k] * ys[k];
    }
    var mat = [[n, sx, si, sy], [sx, sxx, sxi, sxy], [si, sxi, sii, siy]];
    for (var col = 0; col < 3; col++) {
      var piv = col;
      for (var r = col + 1; r < 3; r++) if (Math.abs(mat[r][col]) > Math.abs(mat[piv][col])) piv = r;
      if (Math.abs(mat[piv][col]) < 1e-12) return { intercept: 3.3114, slope: -0.5269, infraCoef: 0.4686, n: n, clampMin: 0.02, clampMax: 0.8 };
      if (piv !== col) { var tmp = mat[col]; mat[col] = mat[piv]; mat[piv] = tmp; }
      for (var r2 = col + 1; r2 < 3; r2++) {
        var f = mat[r2][col] / mat[col][col];
        for (var c = col; c < 4; c++) mat[r2][c] -= f * mat[col][c];
      }
    }
    var coef = [0, 0, 0];
    for (var r3 = 2; r3 >= 0; r3--) {
      var v = mat[r3][3];
      for (var c2 = r3 + 1; c2 < 3; c2++) v -= mat[r3][c2] * coef[c2];
      coef[r3] = v / mat[r3][r3];
    }
    if (!isFinite(coef[0]) || !isFinite(coef[1]) || !isFinite(coef[2])) {
      return { intercept: 3.3114, slope: -0.5269, infraCoef: 0.4686, n: n, clampMin: 0.02, clampMax: 0.8 };
    }
    return { intercept: coef[0], slope: coef[1], infraCoef: coef[2], n: n, clampMin: 0.02, clampMax: 0.8 };
  }

  function sizeMultiple(tvl, curve, infra) {
    var c = curve || { intercept: 3.3114, slope: -0.5269, infraCoef: 0.4686, clampMin: 0.02, clampMax: 0.8 };
    var lo = c.clampMin === undefined ? 0.02 : c.clampMin;
    var hi = c.clampMax === undefined ? 0.8 : c.clampMax;
    if (typeof tvl !== "number" || !isFinite(tvl) || tvl <= 0) return lo;
    var shift = (c.infraCoef === undefined ? 0 : c.infraCoef) * (infra || 0);
    var v = Math.pow(10, c.intercept + c.slope * (Math.log(tvl) / Math.LN10) + shift);
    if (!isFinite(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function growthMultiplier(change7d) {
    var c = (typeof change7d === "number" && isFinite(change7d)) ? change7d : 0;
    if (c < -30) c = -30;
    if (c > 30) c = 30;
    return 1 + c / 100;
  }

  function maturityMultiplier(ageDaysVal) {
    var a = (typeof ageDaysVal === "number" && isFinite(ageDaysVal)) ? ageDaysVal : 365;
    if (a < 0) a = 0;
    if (a > 1095) a = 1095;
    return 0.7 + 0.3 * a / 1095;
  }

  function valueIfLaunches(protocol, asOf, curve) {
    if (!protocol) return 1;
    var tvl = protocol.tvl_usd;
    if (typeof tvl !== "number" || !isFinite(tvl) || tvl <= 0) return 1;
    var v = tvl * sizeMultiple(tvl, curve, isInfra(protocol.category)) *
      growthMultiplier(protocol.change_7d) * maturityMultiplier(ageDays(asOf, protocol.listed_at));
    if (!isFinite(v) || v < 1) return 1;
    return v;
  }

  function recordsToken(protocol) {
    if (!protocol) return false;
    return protocol.mcap_usd !== null && protocol.mcap_usd !== undefined ? true :
      (protocol.gecko_id !== null && protocol.gecko_id !== undefined ? true :
        (protocol.symbol !== null && protocol.symbol !== undefined));
  }

  function sigmoid(z) {
    if (z > 700) return 1;
    if (z < -700) return 0;
    return 1 / (1 + Math.exp(-z));
  }

  // Grouped category flags from full-sample launch rates: high
  // (Lending, Dexs, Basis Trading, Yield: 0.59-0.79) and low (Risk
  // Curators, CEX, Onchain Capital Allocator: 0.13-0.31).
  function isHighLaunchCat(category) {
    return category === "Lending" || category === "Dexs" ||
      category === "Basis Trading" || category === "Yield" ? 1 : 0;
  }

  function isLowLaunchCat(category) {
    return category === "Risk Curators" || category === "CEX" ||
      category === "Onchain Capital Allocator" ? 1 : 0;
  }

  // High-rate-chain flag: 1 when any chain is Fantom, Mantle,
  // Polygon, Optimism or Base (full-sample rates 0.65-0.81).
  function isHighRateChain(chains) {
    var list = chains || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c === "Fantom" || c === "Mantle" || c === "Polygon" ||
        c === "Optimism" || c === "Base") return 1;
    }
    return 0;
  }

  // Twelve odds features: log age, Dexs, Lending, bridge-like, liquid
  // staking-like, CEX, missing listing date, log10 TVL, chain count,
  // high-launch-category flag, low-launch-category flag, high-rate-chain flag.
  // Growth is not an odds feature.
  function oddsFeatures(protocol, asOf, medianAge) {
    var age = ageDays(asOf, protocol ? protocol.listed_at : null);
    if (age === null || age === undefined || !isFinite(age)) age = medianAge;
    var category = protocol ? protocol.category : null;
    var isDex = category === "Dexs";
    var isLending = category === "Lending";
    var isBridgeFamily = category === "Bridge" || category === "Canonical Bridge" || category === "Cross Chain Bridge";
    var isLiquidStakingFamily = category === "Liquid Staking" || category === "Liquid Restaking" || category === "Restaked BTC";
    var isCEX = category === "CEX";
    var listedNull = protocol ? protocol.listed_at === null || protocol.listed_at === undefined : true;
    var tvl = protocol ? protocol.tvl_usd : 0;
    var logTvl = (typeof tvl === "number" && isFinite(tvl) && tvl > 0) ? Math.log(tvl) / Math.LN10 : 0;
    var chainCount = protocol && Array.isArray(protocol.chains) ? protocol.chains.length : 0;
    return [
      Math.log1p(age),
      isDex ? 1 : 0,
      isLending ? 1 : 0,
      isBridgeFamily ? 1 : 0,
      isLiquidStakingFamily ? 1 : 0,
      isCEX ? 1 : 0,
      listedNull ? 1 : 0,
      logTvl,
      chainCount,
      isHighLaunchCat(category),
      isLowLaunchCat(category),
      isHighRateChain(protocol ? protocol.chains : null)
    ];
  }

  function fitOddsModel(protocols, asOf) {
    var list = protocols || [];
    var n = list.length;
    var k = 12;
    var ages = [];
    for (var i = 0; i < n; i++) {
      var a = ageDays(asOf, list[i] ? list[i].listed_at : null);
      if (a !== null && a !== undefined && isFinite(a)) ages.push(a);
    }
    var medianAge = median(ages);
    var X = [], y = [], sumY = 0;
    for (var j = 0; j < n; j++) {
      X.push(oddsFeatures(list[j], asOf, medianAge));
      var label = recordsToken(list[j]) ? 1 : 0;
      y.push(label);
      sumY += label;
    }
    var means = new Array(k), sds = new Array(k);
    for (var f = 0; f < k; f++) {
      var m = 0;
      for (var r = 0; r < n; r++) m += X[r][f];
      m = n ? m / n : 0;
      means[f] = m;
      var s = 0;
      for (var r2 = 0; r2 < n; r2++) { var d = X[r2][f] - m; s += d * d; }
      s = n ? Math.sqrt(s / n) : 0;
      sds[f] = s === 0 || !isFinite(s) ? 1 : s;
    }
    var Z = [];
    for (var r3 = 0; r3 < n; r3++) {
      var row = new Array(k);
      for (var f2 = 0; f2 < k; f2++) row[f2] = (X[r3][f2] - means[f2]) / sds[f2];
      Z.push(row);
    }
    var baseRate = n ? sumY / n : 0;
    if (baseRate < 1e-6) baseRate = 1e-6;
    if (baseRate > 1 - 1e-6) baseRate = 1 - 1e-6;
    var weights = new Array(k);
    for (var w = 0; w < k; w++) weights[w] = 0;
    var bias = Math.log(baseRate / (1 - baseRate));
    var lr = 0.1, iters = 3000, l2 = 0.02;
    for (var it = 0; it < iters; it++) {
      var gradW = new Array(k);
      for (var g = 0; g < k; g++) gradW[g] = 0;
      var gradB = 0;
      for (var m2 = 0; m2 < n; m2++) {
        var z = bias;
        for (var f3 = 0; f3 < k; f3++) z += weights[f3] * Z[m2][f3];
        var err = sigmoid(z) - y[m2];
        gradB += err;
        for (var f4 = 0; f4 < k; f4++) gradW[f4] += err * Z[m2][f4];
      }
      if (n) {
        gradB /= n;
        for (var f5 = 0; f5 < k; f5++) gradW[f5] /= n;
      }
      for (var f6 = 0; f6 < k; f6++) weights[f6] -= lr * (gradW[f6] + l2 * weights[f6]);
      bias -= lr * gradB;
    }
    return { weights: weights, bias: bias, means: means, sds: sds, baseRate: baseRate, medianAge: medianAge };
  }

  function oddsOf(protocol, model, asOf) {
    if (!model) return 1;
    var feats = oddsFeatures(protocol, asOf, model.medianAge);
    var z = model.bias;
    for (var i = 0; i < feats.length; i++) {
      var std = (feats[i] - model.means[i]) / model.sds[i];
      z += model.weights[i] * std;
    }
    var p = sigmoid(z);
    if (!isFinite(p)) p = model.baseRate;
    if (p < 0.001) p = 0.001;
    if (p > 0.999) p = 0.999;
    return p;
  }

  function residualSd(live, curve, asOf) {
    var list = live || [];
    var vals = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      var tvl = p.tvl_usd, mcap = p.mcap_usd;
      if (typeof tvl !== "number" || typeof mcap !== "number") continue;
      if (!isFinite(tvl) || !isFinite(mcap) || tvl <= 0 || mcap <= 0) continue;
      var pred = tvl * sizeMultiple(tvl, curve, isInfra(p.category)) *
        growthMultiplier(p.change_7d) * maturityMultiplier(ageDays(asOf, p.listed_at));
      if (!isFinite(pred) || pred <= 0) continue;
      vals.push(Math.log(mcap / pred) / Math.LN10);
    }
    var count = vals.length;
    if (count < 10) return 0.798;
    var sum = 0;
    for (var j = 0; j < count; j++) sum += vals[j];
    var mu = sum / count;
    var ss = 0;
    for (var k2 = 0; k2 < count; k2++) { var d = vals[k2] - mu; ss += d * d; }
    return Math.sqrt(ss / count);
  }

  // No pre-token haircut: no launched/unlaunched pair in this
  // snapshot can fit a discount, so none is applied.
  function impliedValue(protocol, curve, oddsModel, residualSdVal, asOf) {
    var base = valueIfLaunches(protocol, asOf, curve);
    var odds = oddsModel ? oddsOf(protocol, oddsModel, asOf) : 1;
    var val = Math.round(base * odds);
    if (!isFinite(val) || val < 1) return 1;
    return val;
  }

  function impliedDetail(protocol, curve, oddsModel, residualSdVal, asOf) {
    var tvl = protocol && typeof protocol.tvl_usd === "number" ? protocol.tvl_usd : 0;
    var sm = sizeMultiple(tvl, curve, isInfra(protocol ? protocol.category : null));
    var gm = growthMultiplier(protocol ? protocol.change_7d : null);
    var mm = maturityMultiplier(ageDays(asOf, protocol ? protocol.listed_at : null));
    var base = valueIfLaunches(protocol, asOf, curve);
    var odds = oddsModel ? oddsOf(protocol, oddsModel, asOf) : 1;
    var implied = impliedValue(protocol, curve, oddsModel, residualSdVal, asOf);
    var sigma = (typeof residualSdVal === "number" && isFinite(residualSdVal)) ? residualSdVal : 0.798;
    var lo = Math.round(implied * Math.pow(10, -0.6745 * sigma));
    if (!isFinite(lo) || lo < 1) lo = 1;
    var hi = Math.round(implied * Math.pow(10, 0.6745 * sigma));
    if (!isFinite(hi) || hi < lo + 1) hi = lo + 1;
    return {
      tvl: tvl, sizeMultiple: sm, growthMult: gm, maturityMult: mm,
      valueIfLaunches: base, odds: odds, implied: implied, rangeLo: lo, rangeHi: hi
    };
  }

  var VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  var WORD_RE = /\b(wrapped|staked|staking)\b/i;
  var EXCHANGE_RE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;

  function isSetAsideCategory(category) {
    return category === "Bridge" || category === "Canonical Bridge" ||
      category === "Liquid Staking" || category === "Liquid Restaking" ||
      category === "Restaked BTC" || category === "CEX";
  }

  function rankable(protocol) {
    if (!protocol) return true;
    if (recordsToken(protocol)) return false;
    if (isSetAsideCategory(protocol.category)) return false;
    var name = typeof protocol.name === "string" ? protocol.name : "";
    if (VERSION_RE.test(name)) return false;
    if (WORD_RE.test(name)) return false;
    if (EXCHANGE_RE.test(name)) return false;
    return true;
  }

  function ledgerPartition(protocols) {
    var list = protocols || [];
    var ranked = 0, tokenTrades = 0;
    var reasons = [
      "category:Bridge", "category:Canonical Bridge", "category:CEX",
      "category:Liquid Staking", "category:Liquid Restaking", "category:Restaked BTC",
      "versioned-name", "wrapped/staked-word", "exchange-name"
    ];
    var counts = {};
    for (var r = 0; r < reasons.length; r++) counts[reasons[r]] = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      if (recordsToken(p)) { tokenTrades++; continue; }
      var cat = p.category;
      var name = typeof p.name === "string" ? p.name : "";
      var reason = null;
      if (cat === "Bridge") reason = "category:Bridge";
      else if (cat === "Canonical Bridge") reason = "category:Canonical Bridge";
      else if (cat === "CEX") reason = "category:CEX";
      else if (cat === "Liquid Staking") reason = "category:Liquid Staking";
      else if (cat === "Liquid Restaking") reason = "category:Liquid Restaking";
      else if (cat === "Restaked BTC") reason = "category:Restaked BTC";
      else if (VERSION_RE.test(name)) reason = "versioned-name";
      else if (WORD_RE.test(name)) reason = "wrapped/staked-word";
      else if (EXCHANGE_RE.test(name)) reason = "exchange-name";
      if (reason) counts[reason] += 1;
      else ranked++;
    }
    var setAside = [];
    for (var s = 0; s < reasons.length; s++) {
      if (counts[reasons[s]] > 0) setAside.push({ reason: reasons[s], count: counts[reasons[s]] });
    }
    return { ranked: ranked, tokenTrades: tokenTrades, setAside: setAside };
  }

  var FEE_USD_PER_TX = {
    Ethereum: 4.5, Arbitrum: 0.15, Base: 0.05, BSC: 0.15,
    Solana: 0.02, Optimism: 0.1, Polygon: 0.05, Avalanche: 0.3
  };

  function farmGas(protocol) {
    var chains = protocol && Array.isArray(protocol.chains) ? protocol.chains : [];
    var primaryChain = chains[0] || "Ethereum";
    var fee = FEE_USD_PER_TX.hasOwnProperty(primaryChain) ? FEE_USD_PER_TX[primaryChain] : 0.5;
    return { primaryChain: primaryChain, fee: fee, gasUsd: 6 * fee + (primaryChain === "Ethereum" ? 0 : 2.0) };
  }

  function farmVerdict(netUsd, netPerHour) {
    if (netUsd >= 25 && netPerHour >= 10) return "FARM";
    if (netUsd >= 0) return "MARGINAL";
    if (netUsd >= -25) return "THIN";
    return "SKIP";
  }

  function planFrom(protocol, impliedValueUsd, depositUsd, dropShare, horizonDays, tbillRate) {
    var g = farmGas(protocol);
    var tvl = protocol && typeof protocol.tvl_usd === "number" ? protocol.tvl_usd : 0;
    var rewardUsd = tvl > 0 ? impliedValueUsd * dropShare * (depositUsd / tvl) : 0;
    var opportunityUsd = depositUsd * tbillRate * horizonDays / 365;
    var netUsd = rewardUsd - g.gasUsd - opportunityUsd;
    var netPerHour = netUsd / 2.7;
    return {
      depositUsd: depositUsd, horizonDays: horizonDays, dropShare: dropShare, tbillRate: tbillRate,
      gasUsd: g.gasUsd, rewardUsd: rewardUsd, opportunityUsd: opportunityUsd,
      netUsd: netUsd, netPerHour: netPerHour, verdict: farmVerdict(netUsd, netPerHour)
    };
  }

  // Standard slice is now $2,000 (was $1,000): gas is fixed while the
  // expected slice scales with the deposit, so slice size is real
  // economics, not a free parameter. Drop 10%, 90 days, T-bill 4.5%.
  function farmEconomics(protocol, impliedValueUsd) {
    return planFrom(protocol, impliedValueUsd, 2000, 0.10, 90, 0.045);
  }

  function whatIfFarm(protocol, impliedValueUsd, opts) {
    opts = opts || {};
    var depositUsd = typeof opts.depositUsd === "number" ? opts.depositUsd : 2000;
    var dropShare = typeof opts.dropShare === "number" ? opts.dropShare : 0.10;
    var horizonDays = typeof opts.horizonDays === "number" ? opts.horizonDays : 90;
    var tbillRate = typeof opts.tbillRate === "number" ? opts.tbillRate : 0.045;
    return planFrom(protocol, impliedValueUsd, depositUsd, dropShare, horizonDays, tbillRate);
  }

  function predMcap(protocol, curve, asOf, opts) {
    opts = opts || {};
    var flatMult = opts.flatMult !== undefined ? opts.flatMult : sizeMultiple(protocol.tvl_usd, curve, isInfra(protocol.category));
    var growth = opts.noGrowth ? 1 : growthMultiplier(protocol.change_7d);
    var mat = opts.noMat ? 1 : maturityMultiplier(ageDays(asOf, protocol.listed_at));
    return protocol.tvl_usd * flatMult * growth * mat;
  }

  function logAbsErr(pred, actual) {
    return Math.abs(Math.log(pred / actual) / Math.LN10);
  }

  function flatMultipleOf(rows) {
    return Math.pow(10, median(rows.map(function (r) {
      return Math.log(r.mcap_usd / r.tvl_usd) / Math.LN10;
    })));
  }

  function backtest(liveProtocols, asOf) {
    var n = liveProtocols.length;
    if (n < 10) return { curve: null, flat: null, n: n };
    var curveErrors = [], flatErrors = [];
    for (var f = 0; f < 5; f++) {
      var train = [], test = [];
      for (var i = 0; i < n; i++) {
        if (i % 5 === f) test.push(liveProtocols[i]);
        else train.push(liveProtocols[i]);
      }
      if (!test.length || train.length < 2) continue;
      var curve = fitSizeCurve(train);
      var flat = flatMultipleOf(train);
      for (var j = 0; j < test.length; j++) {
        var p = test[j];
        curveErrors.push(logAbsErr(predMcap(p, curve, asOf), p.mcap_usd));
        flatErrors.push(logAbsErr(predMcap(p, curve, asOf, { flatMult: flat }), p.mcap_usd));
      }
    }
    return { curve: Math.pow(10, median(curveErrors)), flat: Math.pow(10, median(flatErrors)), n: n };
  }

  function backtestValue(liveProtocols, asOf) {
    var n = liveProtocols.length;
    if (n < 10) return { cvCurve: null, cvFlat: null, looCurve: null, looFlat: null, walkForward: [] };
    var cvCurveErrors = [], cvFlatErrors = [];
    for (var f = 0; f < 5; f++) {
      var train = [], test = [];
      for (var i = 0; i < n; i++) {
        if (i % 5 === f) test.push(liveProtocols[i]);
        else train.push(liveProtocols[i]);
      }
      if (!test.length || train.length < 2) continue;
      var curve = fitSizeCurve(train);
      var flat = flatMultipleOf(train);
      for (var j = 0; j < test.length; j++) {
        var p = test[j];
        cvCurveErrors.push(logAbsErr(predMcap(p, curve, asOf), p.mcap_usd));
        cvFlatErrors.push(logAbsErr(predMcap(p, curve, asOf, { flatMult: flat }), p.mcap_usd));
      }
    }
    var looCurveErrors = [], looFlatErrors = [];
    for (var k = 0; k < n; k++) {
      var tr = [];
      for (var m = 0; m < n; m++) if (m !== k) tr.push(liveProtocols[m]);
      var held = liveProtocols[k];
      var cLoo = fitSizeCurve(tr);
      var fLoo = flatMultipleOf(tr);
      looCurveErrors.push(logAbsErr(predMcap(held, cLoo, asOf), held.mcap_usd));
      looFlatErrors.push(logAbsErr(predMcap(held, cLoo, asOf, { flatMult: fLoo }), held.mcap_usd));
    }
    var walkForward = [];
    var cutoffs = ['2024-01-01', '2024-07-01', '2025-01-01'];
    for (var ci = 0; ci < cutoffs.length; ci++) {
      var cutoff = cutoffs[ci];
      var trW = [], teW = [];
      for (var q = 0; q < n; q++) {
        var lp = liveProtocols[q];
        if (!lp.listed_at) continue;
        if (String(lp.listed_at) < cutoff) trW.push(lp);
        else teW.push(lp);
      }
      if (trW.length < 10 || teW.length < 5) continue;
      var cW = fitSizeCurve(trW);
      var fW = flatMultipleOf(trW);
      var sd = residualSd(trW, cW, asOf);
      var span = Math.pow(10, 0.6745 * sd);
      var eC = [], eF = [], eG = [], eM = [], holds = 0;
      for (var t = 0; t < teW.length; t++) {
        var pp = teW[t];
        var pC = predMcap(pp, cW, asOf);
        eC.push(logAbsErr(pC, pp.mcap_usd));
        eF.push(logAbsErr(predMcap(pp, cW, asOf, { flatMult: fW }), pp.mcap_usd));
        eG.push(logAbsErr(predMcap(pp, cW, asOf, { noGrowth: true }), pp.mcap_usd));
        eM.push(logAbsErr(predMcap(pp, cW, asOf, { noMat: true }), pp.mcap_usd));
        if (pp.mcap_usd >= pC / span && pp.mcap_usd <= pC * span) holds++;
      }
      walkForward.push({
        cutoff: cutoff, train: trW.length, test: teW.length,
        miss: Math.pow(10, median(eC)), missFlat: Math.pow(10, median(eF)),
        missNoGrowth: Math.pow(10, median(eG)), missNoMaturity: Math.pow(10, median(eM)),
        sd: sd, holdsPct: 100 * holds / teW.length
      });
    }
    return {
      cvCurve: Math.pow(10, median(cvCurveErrors)), cvFlat: Math.pow(10, median(cvFlatErrors)),
      looCurve: Math.pow(10, median(looCurveErrors)), looFlat: Math.pow(10, median(looFlatErrors)),
      walkForward: walkForward
    };
  }

  function trainOddsWithStats(rows, labels, means, sds, baseRate) {
    var n = rows.length;
    var d = n ? rows[0].length : 0;
    var X = [];
    for (var i = 0; i < n; i++) {
      var z = [];
      for (var k = 0; k < d; k++) z.push(sds[k] === 0 ? 0 : (rows[i][k] - means[k]) / sds[k]);
      X.push(z);
    }
    var weights = [], bias;
    for (var w = 0; w < d; w++) weights.push(0);
    var br = Math.min(1 - 1e-6, Math.max(1e-6, baseRate));
    bias = Math.log(br / (1 - br));
    var lr = 0.1, l2 = 0.02, iters = 3000;
    for (var it = 0; it < iters; it++) {
      if (!n) break;
      var gw = [];
      for (var g = 0; g < d; g++) gw.push(0);
      var gb = 0;
      for (var a = 0; a < n; a++) {
        var s = bias;
        for (var b = 0; b < d; b++) s += weights[b] * X[a][b];
        var err = sigmoid(s) - labels[a];
        for (var c = 0; c < d; c++) gw[c] += err * X[a][c];
        gb += err;
      }
      for (var e = 0; e < d; e++) weights[e] -= lr * (gw[e] / n + l2 * weights[e]);
      bias -= lr * (gb / n);
    }
    return { weights: weights, bias: bias };
  }

  function backtestOdds(protocols, asOf) {
    var n = protocols.length;
    var full = fitOddsModel(protocols, asOf);
    var medianAge = full.medianAge;
    var means = full.means, sds = full.sds;
    var labelsAll = protocols.map(function (p) { return recordsToken(p) ? 1 : 0; });
    var rowsAll = protocols.map(function (p) { return oddsFeatures(p, asOf, medianAge); });
    var baseRate = full.baseRate;
    var baseBrier = baseRate * (1 - baseRate);
    function cvBrierFor(drop) {
      var kept = [];
      for (var k = 0; k < rowsAll[0].length; k++) if (drop.indexOf(k) === -1) kept.push(k);
      var total = 0, count = 0;
      for (var f = 0; f < 5; f++) {
        var trIdx = [], teIdx = [];
        for (var i = 0; i < n; i++) { if (i % 5 === f) teIdx.push(i); else trIdx.push(i); }
        var m = trainOddsWithStats(
          trIdx.map(function (i) { return kept.map(function (k2) { return rowsAll[i][k2]; }); }),
          trIdx.map(function (i) { return labelsAll[i]; }),
          kept.map(function (k2) { return means[k2]; }),
          kept.map(function (k2) { return sds[k2]; }),
          baseRate
        );
        for (var t = 0; t < teIdx.length; t++) {
          var z = m.bias;
          kept.forEach(function (k2, idx) {
            var s = sds[k2] === 0 ? 0 : (rowsAll[teIdx[t]][k2] - means[k2]) / sds[k2];
            z += m.weights[idx] * s;
          });
          var pr = sigmoid(z);
          total += (pr - labelsAll[teIdx[t]]) * (pr - labelsAll[teIdx[t]]);
          count++;
        }
      }
      return count ? total / count : null;
    }
    var cvBrier = cvBrierFor([]);
    var idx = [];
    for (var s0 = 0; s0 < n; s0++) idx.push(s0);
    var rnd = mulberry32(20261121);
    for (var s1 = n - 1; s1 > 0; s1--) {
      var jSwap = Math.floor(rnd() * (s1 + 1));
      var tmp = idx[s1]; idx[s1] = idx[jSwap]; idx[jSwap] = tmp;
    }
    var nTest = Math.floor(n * 0.2);
    var holdoutBrier = null;
    if (nTest > 0 && n - nTest >= 2) {
      var hoTrainRows = [], hoTrainLabels = [], hoTest = idx.slice(0, nTest);
      for (var h = nTest; h < n; h++) {
        hoTrainRows.push(rowsAll[idx[h]]);
        hoTrainLabels.push(labelsAll[idx[h]]);
      }
      var mh = trainOddsWithStats(hoTrainRows, hoTrainLabels, means, sds, baseRate);
      var tot = 0;
      for (var t3 = 0; t3 < hoTest.length; t3++) {
        var raw = rowsAll[hoTest[t3]];
        var z2 = mh.bias;
        for (var k3 = 0; k3 < raw.length; k3++) {
          var s3 = sds[k3] === 0 ? 0 : (raw[k3] - means[k3]) / sds[k3];
          z2 += mh.weights[k3] * s3;
        }
        var prh = sigmoid(z2);
        tot += (prh - labelsAll[hoTest[t3]]) * (prh - labelsAll[hoTest[t3]]);
      }
      holdoutBrier = tot / hoTest.length;
    }
    return {
      cvBrier: cvBrier, holdoutBrier: holdoutBrier, baseBrier: baseBrier,
      ablations: {
        dropAge: cvBrierFor([0]),
        dropCatFlags: cvBrierFor([1, 2, 3, 4, 5]),
        dropListedNull: cvBrierFor([6]),
        dropLogTvl: cvBrierFor([7]),
        dropChains: cvBrierFor([8]),
        dropHighCat: cvBrierFor([9]),
        dropLowCat: cvBrierFor([10]),
        dropHighChain: cvBrierFor([11])
      }
    };
  }

  function percentileOf(sorted, q) {
    if (!sorted.length) return null;
    var index = q * (sorted.length - 1);
    var lo = Math.floor(index), hi = Math.ceil(index);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
  }

  function bootstrapSlope(liveProtocols) {
    var n = liveProtocols.length;
    if (n < 10) return { p25: -0.5269, p75: -0.5269, n: 0 };
    var rnd = mulberry32(20261121);
    var slopes = [];
    for (var b = 0; b < 200; b++) {
      var sample = [];
      for (var i = 0; i < n; i++) sample.push(liveProtocols[Math.floor(rnd() * n)]);
      var curve = fitSizeCurve(sample);
      var s = curve ? curve.slope : null;
      if (typeof s === 'number' && isFinite(s)) slopes.push(s);
    }
    slopes.sort(function (a, b2) { return a - b2; });
    return { p25: percentileOf(slopes, 0.25), p75: percentileOf(slopes, 0.75), n: 200 };
  }

  // Compact port of lib/model.ts generateFarmSteps (M5). The browser
  // dialog reads its steps from data.js; this keeps the same
  // per-category distinct closing lines for a browser rebuild.
  var FARM_PLANS = {
    Dexs: ['Add the stake as liquidity in the largest pool the snapshot lists, keeping the receipt. Cost: pool gas plus the deposit. Time: 10-20 minutes.', 'Pull the liquidity out of the pool the week the token goes live, swapping the LP tokens back to stables in one transaction. Cost: exit gas plus pool fees. Time: 10-30 minutes.'],
    'Risk Curators': ['Deposit the stake into the largest curator vault on the chain the snapshot lists. Cost: vault gas plus the deposit. Time: 10-20 minutes.', 'Redeem the vault shares after the launch announcement, converting the position back to the deposit asset. Cost: redemption gas. Time: 20-40 minutes.'],
    'Onchain Capital Allocator': ['Allocate the stake to the strategy vault with the largest TVL on the chain the snapshot lists, after reading its latest rebalancing note. Cost: vault gas plus the deposit. Time: 15-30 minutes.', 'Queue a withdrawal from the allocator vault once the token is announced, then move the funds to cold storage. Cost: withdrawal gas. Time: 15-30 minutes.'],
    RWA: ['Buy the tokenised asset share the snapshot lists, holding it in the separate wallet for the full hold period. Cost: purchase gas plus the stake. Time: 15-30 minutes.', 'Sell the tokenised share on the same venue once the token launches, converting the position back to stables. Cost: sale gas plus venue fees. Time: 10-20 minutes.'],
    Lending: ['Supply the stake as collateral on the lending market the snapshot lists, then borrow a small amount against it. Cost: supply gas plus the stake. Time: 10-20 minutes.', 'Repay the borrow, withdraw the supplied collateral in full, and close the lending position. Cost: repayment gas. Time: 15-30 minutes.'],
    Yield: ['Stake the deposit in the highest-TVL yield pool on the chain the snapshot lists, keeping the pool receipt. Cost: stake gas plus the deposit. Time: 10-20 minutes.', 'Unstake the yield position and harvest the accrued rewards in the same week the token goes live. Cost: unstake gas. Time: 10-20 minutes.'],
    Derivatives: ['Open a small hedged position on the derivatives market the snapshot lists, sized to the stake, and set the liquidation price in a note. Cost: position gas plus margin. Time: 15-30 minutes.', 'Close the hedged position once the token launches, collecting the margin back and the funding earned. Cost: close gas. Time: 10-20 minutes.'],
    CDP: ['Lock the stake as collateral in the CDP vault the snapshot lists and mint a modest amount of the stablecoin. Cost: vault gas plus the stake. Time: 15-30 minutes.', 'Repay the minted stablecoin, unlock the collateral in full, and close the vault. Cost: repayment gas. Time: 15-30 minutes.'],
    'Yield Aggregator': ['Deposit the stake into the aggregator vault with the largest TVL on the chain the snapshot lists. Cost: vault gas plus the deposit. Time: 10-20 minutes.', 'Withdraw from the aggregator vault the week the token goes live, converting the shares back to the deposit asset. Cost: withdrawal gas. Time: 10-20 minutes.'],
    'Basis Trading': ['Place the stake in the basis strategy the snapshot lists, recording the funding rate at entry in a note. Cost: strategy gas plus the deposit. Time: 15-30 minutes.', 'Exit the basis strategy once the token launches, collecting the stake plus the funding earned. Cost: exit gas. Time: 10-20 minutes.'],
    Chain: ['Bridge the stake to the chain the snapshot lists and stake it with a validator that the chain docs name. Cost: bridge fee plus the stake. Time: 15-30 minutes.', 'Unstake on the chain, bridge the funds back to the wallet chain, and close the position. Cost: bridge fee plus claim gas. Time: 20-40 minutes.'],
    Vault: ['Stake the deposit in the vault the snapshot lists, keeping the receipt and the unbonding period in a note. Cost: stake gas plus the deposit. Time: 10-20 minutes.', 'Start the unbonding, wait out the unbonding window, then claim the staked principal back. Cost: claim gas. Time: 10 minutes plus the unbonding wait.'],
    Participate: ['Join the market or vote the snapshot lists with the stake, keeping the entry receipt. Cost: entry gas plus the stake. Time: 10-20 minutes.', 'Settle the participation once the market closes, collecting the stake and any winnings in one transaction. Cost: settlement gas. Time: 10-20 minutes.'],
    Trade: ['Place the stake in the trade the snapshot lists, with the entry price and the exit price written in a note. Cost: trade gas plus the stake. Time: 10-20 minutes.', 'Close the trade once the token launches, converting the position back to stables. Cost: exit gas. Time: 10-20 minutes.']
  };
  function planKeyOf(category) {
    if (FARM_PLANS[category]) return category;
    if (['Staking Pool', 'Restaking', 'Leveraged Farming', 'Farm', 'Anchor BTC', 'Decentralized BTC', 'Liquidity Manager', 'CeDeFi'].indexOf(category) !== -1) return 'Vault';
    if (['Prediction Market', 'Governance Incentives', 'Social', 'Gaming'].indexOf(category) !== -1) return 'Participate';
    return 'Trade';
  }
  function generateFarmSteps(protocol, asOf) {
    var chain = (protocol.chains && protocol.chains[0]) || 'Ethereum';
    var cap = protocol.tvl_usd >= 5000000000 ? '$250' : protocol.tvl_usd >= 1000000000 ? '$150' : protocol.tvl_usd >= 100000000 ? '$100' : '$50';
    var age = ageDays(asOf, protocol.listed_at);
    var hold = age !== null && age > 1095 ? '60' : age !== null && age > 500 ? '45' : '30';
    var plan = FARM_PLANS[planKeyOf(protocol.category)];
    return [
      'Set up a separate wallet on ' + chain + ' for this one ' + protocol.name + ' only, so its deposits never mix with other farms. Cost: nominal gas only. Time: 5-10 minutes.',
      'Move ' + cap + ' in stables into that wallet, bridging from your main wallet if needed. Cost: ' + cap + ' plus the bridge fee. Time: 10-20 minutes.',
      plan[0],
      'Hold the position for ' + hold + ' days, checking the project channel once a week for a launch date or a snapshot announcement. Cost: none. Time: ' + hold + ' days of waiting.',
      'Check the position once a week and record any deposit receipt, transaction hash, or snapshot proof in a note for the claim later. Cost: none. Time: 5 minutes per week.',
      plan[1]
    ];
  }

  window.TokenRadarModel = {
    median: median, mulberry32: mulberry32, ageDays: ageDays, isInfra: isInfra,
    fitSizeCurve: fitSizeCurve, sizeMultiple: sizeMultiple,
    growthMultiplier: growthMultiplier, maturityMultiplier: maturityMultiplier,
    valueIfLaunches: valueIfLaunches, recordsToken: recordsToken, sigmoid: sigmoid,
    oddsFeatures: oddsFeatures, fitOddsModel: fitOddsModel, oddsOf: oddsOf,
    isHighLaunchCat: isHighLaunchCat, isLowLaunchCat: isLowLaunchCat, isHighRateChain: isHighRateChain,
    residualSd: residualSd, impliedValue: impliedValue, impliedDetail: impliedDetail,
    rankable: rankable, ledgerPartition: ledgerPartition, FEE_USD_PER_TX: FEE_USD_PER_TX,
    farmEconomics: farmEconomics, whatIfFarm: whatIfFarm, generateFarmSteps: generateFarmSteps, backtest: backtest,
    backtestValue: backtestValue, backtestOdds: backtestOdds, bootstrapSlope: bootstrapSlope
  };
})();
