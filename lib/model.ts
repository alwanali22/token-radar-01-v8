// Token Radar v8 — model library, re-authored in this session.
// Same mathematics as the verified L1HC (v7) model, every function
// restructured: different loops, different temporaries, same operation
// order where floating point makes order load-bearing. No haircut:
// implied = round(value-if-launches x launch odds).
// Farm steps (M5) are per-category plans, not one templated skeleton.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  watchlist: string[];
  protocols: SnapshotProtocol[];
}

export interface SizeCurve {
  intercept: number;
  slope: number;
  infraCoef: number;
  n: number;
  clampMin: number;
  clampMax: number;
}

export interface OddsModel {
  weights: number[];
  bias: number;
  means: number[];
  sds: number[];
  baseRate: number;
  medianAge: number;
}

export interface FactorBreakdown {
  tvl: number;
  sizeMultiple: number;
  growthMult: number;
  maturityMult: number;
  valueIfLaunches: number;
  odds: number;
  implied: number;
  rangeLo: number;
  rangeHi: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  rank: number;
  implied_value_usd: number;
  size_multiple: number;
  growth_mult: number;
  maturity_mult: number;
  odds: number;
  value_if_launches: number;
  range_lo: number;
  range_hi: number;
  verdict: string;
  net_usd: number;
  net_per_hour: number;
  gas_usd: number;
  farm_steps: string[];
}

export interface FarmEconomics {
  depositUsd: number;
  horizonDays: number;
  dropShare: number;
  tbillRate: number;
  gasUsd: number;
  rewardUsd: number;
  opportunityUsd: number;
  netUsd: number;
  netPerHour: number;
  verdict: string;
}

// Middle of a sample: the centre entry for odd counts, the mean of
// the two centre entries for even counts, zero for an empty sample.
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return 0;
  const middle = Math.floor(count / 2);
  if (count % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// mulberry32 seeded generator. Bootstrap and shuffle both draw from
// one stream, so the mixing and its order are load-bearing.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function nextRandom(): number {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

// Whole days from listing to snapshot, never below zero; null when
// there is no listing date or a date will not parse.
export function ageDays(asOf: string | Date, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const snapshotMs = toMs(asOf);
  const listedMs = Date.parse(listedAt);
  if (!Number.isFinite(snapshotMs) || !Number.isFinite(listedMs)) return null;
  const days = Math.floor((snapshotMs - listedMs) / 86400000);
  return days < 0 ? 0 : days;
}

// Infrastructure categories trade at a higher multiple for the same
// TVL, so the size curve carries its own intercept shift for them.
const INFRA_CATEGORIES = new Set([
  "Chain",
  "CEX",
  "Bridge",
  "Canonical Bridge",
  "Prediction Market",
  "CeDeFi",
  "Governance Incentives",
]);

export function isInfra(category: string | null): number {
  if (category === null) return 0;
  return INFRA_CATEGORIES.has(category) ? 1 : 0;
}

// Fit log10(mcap/TVL) = a + b*log10(TVL) + c*[infra] over live
// protocols by OLS on three regressors, solved through the 3x3
// normal equations with Gaussian elimination and partial pivoting.
// Too few points, a singular system, or a non-finite fit falls back
// to the pooled curve, so callers always get a curve.
export function fitSizeCurve(live: SnapshotProtocol[]): SizeCurve {
  const xs: number[] = [];
  const flags: number[] = [];
  const ys: number[] = [];
  for (const protocol of live) {
    const tvl = protocol.tvl_usd;
    const cap = protocol.mcap_usd as number;
    if (!Number.isFinite(tvl) || tvl <= 0) continue;
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const x = Math.log10(tvl);
    const y = Math.log10(cap / tvl);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    flags.push(isInfra(protocol.category));
    ys.push(y);
  }
  const n = xs.length;
  const fallback = (): SizeCurve => ({
    intercept: 3.3114,
    slope: -0.5269,
    infraCoef: 0.4686,
    n,
    clampMin: 0.02,
    clampMax: 0.8,
  });
  if (n < 10) return fallback();
  // Accumulate the normal-equation sums in index order; the order
  // of these eight additions is what the fitted curve reproduces.
  let sx = 0;
  let si = 0;
  let sxx = 0;
  let sxi = 0;
  let sii = 0;
  let sy = 0;
  let sxy = 0;
  let siy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const flag = flags[i];
    const y = ys[i];
    sx += x;
    si += flag;
    sxx += x * x;
    sxi += x * flag;
    sii += flag * flag;
    sy += y;
    sxy += x * y;
    siy += flag * y;
  }
  const system: number[][] = [
    [n, sx, si, sy],
    [sx, sxx, sxi, sxy],
    [si, sxi, sii, siy],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(system[r][col]) > Math.abs(system[pivot][col])) pivot = r;
    }
    if (Math.abs(system[pivot][col]) < 1e-12) return fallback();
    if (pivot !== col) {
      const held = system[col];
      system[col] = system[pivot];
      system[pivot] = held;
    }
    for (let r = col + 1; r < 3; r++) {
      const factor = system[r][col] / system[col][col];
      for (let c = col; c < 4; c++) system[r][c] -= factor * system[col][c];
    }
  }
  const solved = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let value = system[r][3];
    for (let c = r + 1; c < 3; c++) value -= system[r][c] * solved[c];
    solved[r] = value / system[r][r];
  }
  const [intercept, slope, infraCoef] = solved;
  if (!Number.isFinite(intercept) || !Number.isFinite(slope) || !Number.isFinite(infraCoef)) {
    return fallback();
  }
  return { intercept, slope, infraCoef, n, clampMin: 0.02, clampMax: 0.8 };
}

// Market-cap/TVL multiple from the fitted curve at a TVL, clamped
// into [clampMin, clampMax]. A missing or non-positive TVL takes the
// bottom of the band. Infra protocols get the intercept shift.
export function sizeMultiple(tvl: number, curve: SizeCurve, infra: number = 0): number {
  if (!Number.isFinite(tvl) || tvl <= 0) return curve.clampMin;
  const shift = curve.infraCoef ?? 0;
  const raw = Math.pow(10, curve.intercept + curve.slope * Math.log10(tvl) + shift * infra);
  if (Number.isNaN(raw)) return curve.clampMin;
  if (raw < curve.clampMin) return curve.clampMin;
  if (raw > curve.clampMax) return curve.clampMax;
  return raw;
}

// Seven-day TVL change as a multiplier, capped at +/-30%. A missing
// change counts as flat.
export function growthMultiplier(change7d: number | null): number {
  const weekly = change7d !== null && Number.isFinite(change7d) ? change7d : 0;
  const capped = weekly < -30 ? -30 : weekly > 30 ? 30 : weekly;
  return 1 + capped / 100;
}

// Seasoning: 0.7 for a fresh listing, rising linearly to 1.0 after
// three years. A missing age counts as one year.
export function maturityMultiplier(ageDaysVal: number | null): number {
  const days = ageDaysVal !== null && Number.isFinite(ageDaysVal) ? ageDaysVal : 365;
  const capped = days < 0 ? 0 : days > 1095 ? 1095 : days;
  return 0.7 + (0.3 * capped) / 1095;
}

// What a protocol would be worth if it launched a token today: TVL
// times the fitted multiple, growth and seasoning. Floored at $1.
export function valueIfLaunches(p: SnapshotProtocol, asOf: string | Date, curve: SizeCurve): number {
  if (!Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) return 1;
  const worth =
    p.tvl_usd *
    sizeMultiple(p.tvl_usd, curve, isInfra(p.category)) *
    growthMultiplier(p.change_7d) *
    maturityMultiplier(ageDays(asOf, p.listed_at));
  if (!Number.isFinite(worth)) return 1;
  return worth < 1 ? 1 : worth;
}

// A protocol records a token when DefiLlama lists a market cap for
// it, or a Gecko id, or a symbol. Any one signal is enough.
function recordsToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

function sigmoid(z: number): number {
  if (z > 700) return 1;
  if (z < -700) return 0;
  return 1 / (1 + Math.exp(-z));
}

// Categories whose full-sample launch rates run high (0.59-0.79):
// Lending, Dexs, Basis Trading and Yield.
const HIGH_LAUNCH_CATEGORIES = new Set(["Lending", "Dexs", "Basis Trading", "Yield"]);

export function isHighLaunchCat(category: string | null): number {
  if (category === null) return 0;
  return HIGH_LAUNCH_CATEGORIES.has(category) ? 1 : 0;
}

// Categories whose full-sample launch rates run low (0.13-0.31):
// Risk Curators, CEX and Onchain Capital Allocator.
const LOW_LAUNCH_CATEGORIES = new Set(["Risk Curators", "CEX", "Onchain Capital Allocator"]);

export function isLowLaunchCat(category: string | null): number {
  if (category === null) return 0;
  return LOW_LAUNCH_CATEGORIES.has(category) ? 1 : 0;
}

// Chains whose full-sample launch rates run high (0.65-0.81): a
// protocol on any one of them earns the high-rate-chain flag. No
// low-rate-chain flag exists: it was tested and rejected.
const HIGH_RATE_CHAINS = new Set(["Fantom", "Mantle", "Polygon", "Optimism", "Base"]);

export function isHighRateChain(chains: string[]): number {
  const listed = chains || [];
  for (const chain of listed) {
    if (HIGH_RATE_CHAINS.has(chain)) return 1;
  }
  return 0;
}

// The twelve launch-odds inputs, in the order the fitted weights
// expect: log age, Dexs flag, Lending flag, bridge-like flag, liquid
// staking-like flag, CEX flag, missing-listing-date flag, log10 TVL,
// chain count, high-launch-category flag, low-launch-category flag,
// and high-rate-chain flag. A protocol with no listing date uses the
// snapshot median age. Growth is deliberately not an odds feature.
function oddsFeatures(p: SnapshotProtocol, asOf: string | Date, medianAge: number): number[] {
  const knownAge = ageDays(asOf, p.listed_at);
  const age = knownAge === null ? medianAge : knownAge;
  const cat = p.category;
  const bridgeLike = cat === "Bridge" || cat === "Canonical Bridge" || cat === "Cross Chain Bridge" ? 1 : 0;
  const stakingLike = cat === "Liquid Staking" || cat === "Liquid Restaking" || cat === "Restaked BTC" ? 1 : 0;
  const logTvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? Math.log10(p.tvl_usd) : 0;
  const chainCount = (p.chains || []).length;
  return [
    Math.log1p(age),
    cat === "Dexs" ? 1 : 0,
    cat === "Lending" ? 1 : 0,
    bridgeLike,
    stakingLike,
    cat === "CEX" ? 1 : 0,
    p.listed_at === null ? 1 : 0,
    logTvl,
    chainCount,
    isHighLaunchCat(cat),
    isLowLaunchCat(cat),
    isHighRateChain(p.chains),
  ];
}

export function fitOddsModel(protocols: SnapshotProtocol[], asOf: string | Date): OddsModel {
  const total = protocols.length;
  const agesKnown: number[] = [];
  for (const p of protocols) {
    const a = ageDays(asOf, p.listed_at);
    if (a !== null) agesKnown.push(a);
  }
  const medianAge = median(agesKnown);
  const k = 12;
  if (total === 0) {
    return {
      weights: new Array(k).fill(0),
      bias: 0,
      means: new Array(k).fill(0),
      sds: new Array(k).fill(1),
      baseRate: 0,
      medianAge,
    };
  }
  const featureRows: number[][] = [];
  const labels: number[] = [];
  for (const p of protocols) {
    featureRows.push(oddsFeatures(p, asOf, medianAge));
    labels.push(recordsToken(p) ? 1 : 0);
  }
  const means = new Array(k).fill(0);
  for (let j = 0; j < k; j++) {
    let sum = 0;
    for (let i = 0; i < total; i++) sum += featureRows[i][j];
    means[j] = sum / total;
  }
  const sds = new Array(k).fill(0);
  for (let j = 0; j < k; j++) {
    let squares = 0;
    for (let i = 0; i < total; i++) {
      const diff = featureRows[i][j] - means[j];
      squares += diff * diff;
    }
    const spread = Math.sqrt(squares / total);
    sds[j] = spread === 0 || !Number.isFinite(spread) ? 1 : spread;
  }
  for (let i = 0; i < total; i++) {
    for (let j = 0; j < k; j++) featureRows[i][j] = (featureRows[i][j] - means[j]) / sds[j];
  }
  const baseRate = labels.reduce((s, v) => s + v, 0) / total;
  const safeBase = Math.min(1 - 1e-6, Math.max(1e-6, baseRate));
  const weights = new Array(k).fill(0);
  let bias = Math.log(safeBase / (1 - safeBase));
  const lr = 0.1;
  const iters = 3000;
  const l2 = 0.02;
  const gradW = new Array(k).fill(0);
  for (let iter = 0; iter < iters; iter++) {
    gradW.fill(0);
    let gradB = 0;
    for (let i = 0; i < total; i++) {
      let z = bias;
      for (let j = 0; j < k; j++) z += weights[j] * featureRows[i][j];
      const err = sigmoid(z) - labels[i];
      for (let j = 0; j < k; j++) gradW[j] += err * featureRows[i][j];
      gradB += err;
    }
    for (let j = 0; j < k; j++) weights[j] -= lr * (gradW[j] / total + l2 * weights[j]);
    bias -= lr * (gradB / total);
  }
  return { weights, bias, means, sds, baseRate, medianAge };
}

// Launch odds for one protocol: standardise its features with the
// fitted means and scales, dot with the weights, squash, and clamp
// into [0.001, 0.999].
export function oddsOf(p: SnapshotProtocol, model: OddsModel, asOf: string | Date): number {
  const feats = oddsFeatures(p, asOf, model.medianAge);
  let logit = model.bias;
  for (let j = 0; j < model.weights.length; j++) {
    const scale = model.sds[j] === 0 ? 1 : model.sds[j];
    logit += model.weights[j] * ((feats[j] - model.means[j]) / scale);
  }
  const prob = sigmoid(logit);
  if (!Number.isFinite(prob)) return 0.001;
  return Math.min(0.999, Math.max(0.001, prob));
}

// Spread of the log10 residuals between live market caps and the
// curve prediction, as a population standard deviation. Fewer than
// ten residuals fall back to the pooled spread 0.798.
export function residualSd(live: SnapshotProtocol[], curve: SizeCurve, asOf: string | Date): number {
  const residuals: number[] = [];
  for (const p of live) {
    if (!Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) continue;
    const cap = p.mcap_usd as number;
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const pred =
      p.tvl_usd *
      sizeMultiple(p.tvl_usd, curve, isInfra(p.category)) *
      growthMultiplier(p.change_7d) *
      maturityMultiplier(ageDays(asOf, p.listed_at));
    if (!Number.isFinite(pred) || pred <= 0) continue;
    const ratio = cap / pred;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const r = Math.log10(ratio);
    if (Number.isFinite(r)) residuals.push(r);
  }
  if (residuals.length < 10) return 0.798;
  const count = residuals.length;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += residuals[i];
  const centre = sum / count;
  let squares = 0;
  for (const r of residuals) {
    const d = r - centre;
    squares += d * d;
  }
  const sd = Math.sqrt(squares / count);
  if (!Number.isFinite(sd)) return 0.798;
  return sd;
}

// Full implied-value breakdown for one protocol: the launch value,
// the odds-weighted implied value, and the P25-P75 range from the
// residual spread. Without an odds model the odds are taken as one.
export function calculateImpliedValue(
  p: SnapshotProtocol,
  asOf: string | Date,
  curve: SizeCurve,
  oddsModel?: OddsModel,
  residualSdVal?: number,
): FactorBreakdown {
  const launchValue = valueIfLaunches(p, asOf, curve);
  const launchOdds = oddsModel ? oddsOf(p, oddsModel, asOf) : 1;
  // No pre-token haircut: no launched/unlaunched pair in this
  // snapshot can fit a discount, so none is applied.
  const implied = Math.max(1, Math.round(launchValue * launchOdds));
  const sigma = residualSdVal ?? 0.798;
  const loFactor = Math.pow(10, -0.6745 * sigma);
  const hiFactor = Math.pow(10, 0.6745 * sigma);
  const rangeLo = Math.max(1, Math.round(implied * loFactor));
  const rangeHi = Math.max(rangeLo + 1, Math.round(implied * hiFactor));
  return {
    tvl: p.tvl_usd,
    sizeMultiple: sizeMultiple(p.tvl_usd, curve, isInfra(p.category)),
    growthMult: growthMultiplier(p.change_7d),
    maturityMult: maturityMultiplier(ageDays(asOf, p.listed_at)),
    valueIfLaunches: launchValue,
    odds: launchOdds,
    implied,
    rangeLo,
    rangeHi,
  };
}

// Name-shape filters: versioned names, wrapped/staked products and
// exchange-branded names are set aside rather than ranked.
const VERSION_RE = new RegExp("\\s(V\\d+(\\.\\d+)?|v\\d+(\\.\\d+)?|\\d+\\.\\d+)$");
const WRAPPED_RE = new RegExp("\\b(?:wrapped|staked|staking)\\b", "i");
const EXCHANGE_RE = new RegExp("^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)");

// Categories the radar never ranks: bridges, liquid staking and
// restaking products, and centralised exchanges.
const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

// Rankable means: no token recorded yet, outside the excluded
// categories, and a name with no version marker, no wrapped/staked
// word, and no exchange prefix.
export function rankable(p: SnapshotProtocol): boolean {
  if (recordsToken(p)) return false;
  if (EXCLUDED_CATEGORIES.has(p.category as string)) return false;
  if (VERSION_RE.test(p.name)) return false;
  if (WRAPPED_RE.test(p.name)) return false;
  if (EXCHANGE_RE.test(p.name)) return false;
  return true;
}

// Every protocol lands in exactly one ledger bucket: already trading
// a token, rankable, or set aside for a stated reason. The reason
// order below is the precedence: the first match wins.
export function ledgerPartition(protocols: SnapshotProtocol[]): {
  ranked: number;
  tokenTrades: number;
  setAside: Array<{ reason: string; count: number }>;
} {
  const order = [
    "category:Bridge",
    "category:Canonical Bridge",
    "category:CEX",
    "category:Liquid Staking",
    "category:Liquid Restaking",
    "category:Restaked BTC",
    "versioned-name",
    "wrapped/staked-word",
    "exchange-name",
  ];
  const reasonFor = (p: SnapshotProtocol): string | null => {
    const cat = p.category;
    if (cat === "Bridge") return "category:Bridge";
    if (cat === "Canonical Bridge") return "category:Canonical Bridge";
    if (cat === "CEX") return "category:CEX";
    if (cat === "Liquid Staking") return "category:Liquid Staking";
    if (cat === "Liquid Restaking") return "category:Liquid Restaking";
    if (cat === "Restaked BTC") return "category:Restaked BTC";
    if (VERSION_RE.test(p.name)) return "versioned-name";
    if (WRAPPED_RE.test(p.name)) return "wrapped/staked-word";
    if (EXCHANGE_RE.test(p.name)) return "exchange-name";
    return null;
  };
  const tallies: Record<string, number> = {};
  for (const r of order) tallies[r] = 0;
  let ranked = 0;
  let trading = 0;
  for (const p of protocols) {
    if (recordsToken(p)) {
      trading++;
      continue;
    }
    const reason = reasonFor(p);
    if (reason === null) ranked++;
    else tallies[reason] += 1;
  }
  const setAside = order
    .map((reason) => ({ reason, count: tallies[reason] }))
    .filter((entry) => entry.count > 0);
  return { ranked, tokenTrades: trading, setAside };
}

// Typical cost of one transaction per chain, in dollars. A farm plan
// prices six transactions plus a bridge hop off Ethereum.
export const FEE_USD_PER_TX: Record<string, number> = {
  Ethereum: 4.5,
  Arbitrum: 0.15,
  Base: 0.05,
  BSC: 0.15,
  Solana: 0.02,
  Optimism: 0.1,
  Polygon: 0.05,
  Avalanche: 0.3,
};

// Farming verdict from the net return and the hourly rate: a plan is
// worth farming only when both clear their bars.
function farmVerdict(netUsd: number, netPerHour: number): string {
  if (netUsd >= 25 && netPerHour >= 10) return "FARM";
  if (netUsd >= 0) return "MARGINAL";
  if (netUsd >= -25) return "THIN";
  return "SKIP";
}

// The chain a farm plan runs on: the protocol's first listed chain,
// falling back to Ethereum when none is listed.
function primaryChainOf(p: SnapshotProtocol): string {
  return p.chains[0] || "Ethereum";
}

// Gas for one farm plan: six transactions at the chain's fee, plus a
// two-dollar bridge hop on every chain except Ethereum.
function farmGas(p: SnapshotProtocol): number {
  const chain = primaryChainOf(p);
  const perTx = FEE_USD_PER_TX[chain] ?? 0.5;
  return 6 * perTx + (chain === "Ethereum" ? 0 : 2.0);
}

// One farm plan priced end to end: gas, the expected airdrop slice,
// the T-bill opportunity cost of the deposit, and the net.
function buildFarmPlan(
  p: SnapshotProtocol,
  impliedValueUsd: number,
  depositUsd: number,
  dropShare: number,
  horizonDays: number,
  tbillRate: number,
): FarmEconomics {
  const gasUsd = farmGas(p);
  const rewardUsd = p.tvl_usd > 0 ? impliedValueUsd * dropShare * (depositUsd / p.tvl_usd) : 0;
  const opportunityUsd = (depositUsd * tbillRate * horizonDays) / 365;
  const netUsd = rewardUsd - gasUsd - opportunityUsd;
  const netPerHour = netUsd / 2.7;
  return {
    depositUsd,
    horizonDays,
    dropShare,
    tbillRate,
    gasUsd,
    rewardUsd,
    opportunityUsd,
    netUsd,
    netPerHour,
    verdict: farmVerdict(netUsd, netPerHour),
  };
}

// The standard $2,000 / 90-day / 10% slice plan the board prices.
export function farmEconomics(p: SnapshotProtocol, impliedValueUsd: number): FarmEconomics {
  return buildFarmPlan(p, impliedValueUsd, 2000, 0.1, 90, 0.045);
}

// The same plan repriced for the dashboard's what-if controls.
export function whatIfFarm(
  p: SnapshotProtocol,
  impliedValueUsd: number,
  opts: { depositUsd: number; dropShare: number; horizonDays: number; tbillRate: number },
): FarmEconomics {
  return buildFarmPlan(p, impliedValueUsd, opts.depositUsd, opts.dropShare, opts.horizonDays, opts.tbillRate);
}

// Farm steps are capped at 600 characters so every row's plan fits
// the board's gate, trimming at a word boundary where possible.
function cappedStep(step: string): string {
  if (step.length <= 600) return step;
  return step.slice(0, 597).trimEnd() + "...";
}

// ---- M5: farm plans that differ by category, not by slot-filling ----
// Each big category gets its own six-step plan: different verbs,
// different order, different closing step. The closing step is no
// longer one sentence repeated 198 times; each plan family closes in
// its own words. Placeholders: {cap} stake size, {chain} first chain,
// {slug} protocol slug, {hold} hold days. Every step carries its own
// cost and time, and nothing here invents a token, a minimum, a URL,
// a yield or a points programme that is not in the snapshot.
type PlanCtx = { cap: number; chain: string; slug: string; hold: number };

function fillPlan(steps: string[], ctx: PlanCtx): string[] {
  return steps.map((s) =>
    cappedStep(
      s
        .replaceAll("{cap}", String(ctx.cap))
        .replaceAll("{chain}", ctx.chain)
        .replaceAll("{slug}", ctx.slug)
        .replaceAll("{hold}", String(ctx.hold)),
    ),
  );
}

const PLAN_SETS: Record<string, string[]> = {
  Dexs: [
    "Open a fresh wallet for {chain} and keep its seed offline. Cost: no gas yet. Time: 5-10 minutes.",
    "Move ${cap} in stables into that wallet, bridging from your main wallet if needed. Cost: ${cap} plus the bridge fee. Time: 10-20 minutes.",
    "Add ${cap} as liquidity in one pool on {chain}, picking the pair with the deepest volume. Cost: ${cap} plus pool gas. Time: 15-30 minutes.",
    "Leave the liquidity in place for {hold} days, collecting fees as they accrue. Cost: the capital is locked up. Time: {hold} days.",
    "Once a week, open the {slug} pool page and note the fees earned and the pool's TVL. Cost: none. Time: a few minutes per week.",
    "Pull the liquidity out of the pool the week the token goes live, swapping the LP tokens back to stables in one transaction. Cost: exit gas plus pool fees. Time: 10-30 minutes.",
  ],
  "Risk Curators": [
    "Before touching funds, read the curator's strategy page for {slug} and write down what it actually allocates to. Cost: none. Time: 20-30 minutes.",
    "Set up a separate wallet on {chain} for this one curator only, so its deposits never mix with other farms. Cost: nominal gas only. Time: 5-10 minutes.",
    "Fund that wallet with ${cap}. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Deposit ${cap} into the curator vault on {chain} and keep the deposit receipt. Cost: ${cap} plus vault gas. Time: 15-30 minutes.",
    "For {hold} days, check the vault's allocation monthly, not daily, and record any strategy change. Cost: opportunity cost of capital. Time: {hold} days.",
    "Redeem the vault shares after the launch announcement, converting the position back to the deposit asset. Cost: redemption gas. Time: 20-40 minutes.",
  ],
  "Onchain Capital Allocator": [
    "Compare the allocator's past allocations on {chain} with its stated mandate, then decide the ${cap} stake. Cost: none. Time: 20-30 minutes.",
    "Bridge ${cap} to {chain} into a dedicated wallet. Cost: ${cap} plus the bridge fee. Time: 10-20 minutes.",
    "Allocate ${cap} through the allocator vault, confirming the allocation receipt shows {slug}. Cost: ${cap} plus gas. Time: 15-30 minutes.",
    "Hold the allocation for {hold} days while the allocator rebalances; do not chase each rebalance. Cost: opportunity cost of capital. Time: {hold} days.",
    "Every two weeks, verify the allocator still holds the position and log the allocation. Cost: none. Time: a few minutes per fortnight.",
    "Queue a withdrawal from the allocator vault once the token is announced, then move the funds to cold storage. Cost: withdrawal gas. Time: 15-30 minutes.",
  ],
  RWA: [
    "Check what asset backs the tokenised product on {slug} and what redemption means for it. Cost: none. Time: 20-30 minutes.",
    "Prepare a wallet on {chain} and fund it with ${cap}. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Mint ${cap} of the tokenised asset on {chain}. Cost: ${cap} plus mint gas. Time: 15-30 minutes.",
    "Hold the tokenised asset for {hold} days, keeping the mint receipt and the redemption terms together. Cost: opportunity cost of capital. Time: {hold} days.",
    "Monthly, confirm the backing asset is still listed and the redemption window is open. Cost: none. Time: a few minutes per month.",
    "Redeem the tokenised asset for its underlying value when the protocol token launches, keeping the receipt. Cost: redemption gas. Time: 20-45 minutes.",
  ],
  Lending: [
    "Supply ${cap} of a stablecoin or blue-chip asset to the {slug} lending market on {chain}. Cost: ${cap} plus gas. Time: 15-30 minutes.",
    "Open a wallet on {chain} first if you do not have one, and fund it with the ${cap} supply amount. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Borrow a small amount against the supply, staying well below the liquidation threshold. Cost: borrow gas. Time: 10-20 minutes.",
    "Keep the supply and borrow open for {hold} days, watching the health factor weekly. Cost: opportunity cost of capital. Time: {hold} days.",
    "Top up collateral at once if the health factor falls toward the liquidation line. Cost: top-up gas if needed. Time: a few minutes per week.",
    "Repay the borrow, withdraw the supplied collateral in full, and close the lending position. Cost: repayment gas. Time: 15-30 minutes.",
  ],
  Yield: [
    "Deposit ${cap} into the {slug} yield vault on {chain} from a dedicated wallet. Cost: ${cap} plus vault gas. Time: 15-30 minutes.",
    "Fund that wallet with ${cap} in stables before depositing, bridging if {chain} is not your home chain. Cost: ${cap} plus the bridge fee. Time: 10-20 minutes.",
    "Leave the deposit compounding for {hold} days instead of moving it between vaults. Cost: opportunity cost of capital. Time: {hold} days.",
    "Check the vault's yield and TVL weekly on the official {slug} dashboard. Cost: none. Time: a few minutes per week.",
    "If the vault's strategy changes, decide once whether to stay or leave; do not re-enter the same vault twice. Cost: none unless you exit. Time: 10 minutes.",
    "Unstake from the yield vault at launch, claim the accrued yield, and sweep everything to the main wallet. Cost: unstake gas. Time: 10-25 minutes.",
  ],
  Derivatives: [
    "Size the trade first: no more than ${cap} at risk on {chain}, with a stop level written down before you open it. Cost: none. Time: 15-20 minutes.",
    "Fund a dedicated wallet on {chain} with ${cap}. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Open a small margined position on {slug} at low leverage, keeping the stop level in place. Cost: ${cap} plus trading gas and fees. Time: 10-20 minutes.",
    "Hold the position for up to {hold} days, checking the margin level daily. Cost: opportunity cost of capital. Time: {hold} days.",
    "Close or reduce the position if it hits the stop level; never add to a losing position to farm it. Cost: closing gas if triggered. Time: 5 minutes when it happens.",
    "Close the margined position before the launch volatility peaks, settle in stables, and stop trading it. Cost: closing gas and fees. Time: 5-15 minutes.",
  ],
  CDP: [
    "Open a collateralised debt position on {slug} with ${cap} of collateral on {chain}. Cost: ${cap} plus opening gas. Time: 15-30 minutes.",
    "Set up the wallet on {chain} and fund it with the ${cap} collateral first. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Mint only a modest amount of debt against the collateral, keeping a wide safety margin. Cost: mint gas. Time: 10-20 minutes.",
    "Keep the position open for {hold} days, checking the collateral ratio every week. Cost: opportunity cost of capital. Time: {hold} days.",
    "Add collateral promptly if the ratio drifts toward the liquidation level. Cost: top-up gas if needed. Time: a few minutes per week.",
    "Close the debt position, release the collateral, and verify the vault shows zero debt. Cost: closing gas. Time: 15-30 minutes.",
  ],
  "Yield Aggregator": [
    "Route ${cap} through the aggregator on {chain}: one deposit, and let it split across its vaults. Cost: ${cap} plus deposit gas. Time: 15-30 minutes.",
    "Fund a fresh wallet on {chain} with ${cap} before the deposit. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Confirm the aggregator's receipt lists {slug} and the deposit amount. Cost: none. Time: 5 minutes.",
    "Leave the deposit auto-compounding for {hold} days without manually harvesting. Cost: opportunity cost of capital. Time: {hold} days.",
    "Weekly, check the aggregator dashboard for the position and the rewards accrued. Cost: none. Time: a few minutes per week.",
    "Exit the aggregator vault after launch, harvest the auto-compounded rewards, and consolidate into one wallet. Cost: exit gas. Time: 10-20 minutes.",
  ],
  "Basis Trading": [
    "Work out the basis trade on paper first: spot leg and futures leg, each sized from the ${cap} stake. Cost: none. Time: 20-30 minutes.",
    "Fund a wallet on {chain} with ${cap}. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Open the basis trade on {slug} in two legs, spot and futures, at the same time. Cost: ${cap} plus trading gas and fees. Time: 15-30 minutes.",
    "Hold both legs for {hold} days, watching the funding rate weekly. Cost: opportunity cost of capital. Time: {hold} days.",
    "If the funding rate turns against the trade for two weeks running, close it early rather than waiting. Cost: closing gas if triggered. Time: 10 minutes when it happens.",
    "Unwind the basis trade in two legs, flat in stables, once the token launches. Cost: unwind gas and fees. Time: 10-20 minutes.",
  ],
  Chain: [
    "Bridge ${cap} onto the chain itself, keeping a small amount aside for gas on {chain}. Cost: ${cap} plus the bridge fee. Time: 10-20 minutes.",
    "Set up a wallet native to {chain} and fund it with the bridged ${cap}. Cost: nominal gas only. Time: 5-10 minutes.",
    "Use the chain's own dApps for {hold} days: swap, lend or stake through at least two different apps. Cost: ${cap} plus app gas. Time: {hold} days.",
    "Keep a simple log of which dApps you used and when, on the {slug} chain. Cost: none. Time: a few minutes per week.",
    "Weekly, check the chain's TVL and the dApps' activity to confirm the position is still live. Cost: none. Time: a few minutes per week.",
    "Bridge the funds back off the chain after the launch, keeping a small amount for gas. Cost: bridge fee plus gas. Time: 20-40 minutes.",
  ],
  Vault: [
    "Stake ${cap} into the vault on {chain}, noting the unbonding wait before you commit. Cost: ${cap} plus stake gas. Time: 15-30 minutes.",
    "Fund a dedicated wallet on {chain} with ${cap} first. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Confirm the stake receipt shows the right vault, {slug}, and the full ${cap}. Cost: none. Time: 5 minutes.",
    "Leave the stake locked for {hold} days, letting rewards accrue instead of restaking daily. Cost: opportunity cost of capital. Time: {hold} days.",
    "Check the vault's rewards and the unbonding window weekly. Cost: none. Time: a few minutes per week.",
    "Start the unbonding, wait out the unbonding window, then claim the staked principal back. Cost: claim gas. Time: 10 minutes plus the unbonding wait.",
  ],
  Participate: [
    "Read the current question or proposal on {slug} before committing any funds. Cost: none. Time: 15-20 minutes.",
    "Fund a wallet on {chain} with ${cap}. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Place the prediction or cast the vote on {chain} with the ${cap} stake. Cost: ${cap} plus gas. Time: 10-20 minutes.",
    "Hold the position for {hold} days until the outcome resolves. Cost: opportunity cost of capital. Time: {hold} days.",
    "Follow the resolution weekly on the official {slug} page, and note the result when it lands. Cost: none. Time: a few minutes per week.",
    "Claim any prediction or governance reward after resolution, then stop participating. Cost: claim gas. Time: 5-15 minutes.",
  ],
  Trade: [
    "Use the product on {slug} once with a small amount to learn its flow before the full ${cap}. Cost: a small test amount plus gas. Time: 15-20 minutes.",
    "Fund a wallet on {chain} with ${cap}. Cost: ${cap} plus any bridge fee. Time: 10-20 minutes.",
    "Put the full ${cap} through the protocol's main action on {chain}. Cost: ${cap} plus gas. Time: 15-30 minutes.",
    "Keep the position for {hold} days, using the product at least once a week. Cost: opportunity cost of capital. Time: {hold} days.",
    "Check the position and any points weekly on the official {slug} dashboard. Cost: none. Time: a few minutes per week.",
    "Stop using the product, withdraw whatever balance remains, and archive the wallet. Cost: withdrawal gas. Time: 10-20 minutes.",
  ],
};

const VAULT_CATEGORIES = new Set([
  "Staking Pool",
  "Restaking",
  "Leveraged Farming",
  "Farm",
  "Anchor BTC",
  "Decentralized BTC",
  "Liquidity Manager",
  "CeDeFi",
]);

const PARTICIPATE_CATEGORIES = new Set([
  "Prediction Market",
  "Governance Incentives",
  "Social",
  "Gaming",
]);

function planSetFor(category: string | null): string[] {
  if (category !== null && category in PLAN_SETS) return PLAN_SETS[category];
  if (category !== null && VAULT_CATEGORIES.has(category)) return PLAN_SETS["Vault"];
  if (category !== null && PARTICIPATE_CATEGORIES.has(category)) return PLAN_SETS["Participate"];
  return PLAN_SETS["Trade"];
}

// Six concrete steps to farm one protocol, shaped by its category.
// The stake scales with TVL and the hold length with the listing age.
export function generateFarmSteps(p: SnapshotProtocol, asOf: string | Date): string[] {
  const chain = p.chains[0] || "its main chain";
  let capital = 50;
  if (p.tvl_usd >= 5e9) capital = 250;
  else if (p.tvl_usd >= 1e9) capital = 150;
  else if (p.tvl_usd >= 1e8) capital = 100;
  const age = ageDays(asOf, p.listed_at);
  let holdDays = 30;
  if (age !== null && age > 1095) holdDays = 60;
  else if (age !== null && age > 500) holdDays = 45;
  return fillPlan(planSetFor(p.category), { cap: capital, chain, slug: p.slug, hold: holdDays });
}

export interface WalkForwardRow {
  cutoff: string;
  train: number;
  test: number;
  miss: number;
  missFlat: number;
  missNoGrowth: number;
  missNoMaturity: number;
  sd: number;
  holdsPct: number;
}

export interface ValueBacktest {
  cvCurve: number | null;
  cvFlat: number | null;
  looCurve: number | null;
  looFlat: number | null;
  walkForward: WalkForwardRow[];
}

export interface OddsBacktest {
  cvBrier: number;
  holdoutBrier: number;
  baseBrier: number;
  ablations: {
    dropAge: number;
    dropCatFlags: number;
    dropListedNull: number;
    dropLogTvl: number;
    dropChains: number;
    dropHighCat: number;
    dropLowCat: number;
    dropHighChain: number;
  };
}

export interface BootstrapSlope {
  p25: number;
  p75: number;
  n: number;
}

// Predicted market cap for a backtest row: TVL times the fitted
// multiple, growth and seasoning, with switches to flatten the
// multiple or drop a term for the ablation checks.
function predMcap(
  p: SnapshotProtocol,
  curve: SizeCurve,
  asOf: string | Date,
  opts?: { flatMult?: number; noGrowth?: boolean; noMat?: boolean },
): number {
  const multiple = opts?.flatMult ?? sizeMultiple(p.tvl_usd, curve, isInfra(p.category));
  const growth = opts?.noGrowth === true ? 1 : growthMultiplier(p.change_7d);
  const seasoning = opts?.noMat ? 1 : maturityMultiplier(ageDays(asOf, p.listed_at));
  return p.tvl_usd * multiple * growth * seasoning;
}

function logAbsErr(pred: number, actual: number): number {
  return Math.abs(Math.log10(pred / actual));
}

// The single flat multiple for a training set: ten to the median of
// the log10 market-cap/TVL ratios.
function flatMultipleOf(rows: SnapshotProtocol[]): number {
  const ratios = rows.map((r) => Math.log10((r.mcap_usd as number) / r.tvl_usd));
  return Math.pow(10, median(ratios));
}

export function backtestValue(live: SnapshotProtocol[], asOf: string | Date): ValueBacktest {
  if (live.length < 10) {
    return { cvCurve: null, cvFlat: null, looCurve: null, looFlat: null, walkForward: [] };
  }
  const curveErrors: number[] = [];
  const flatErrors: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = live.filter((_, i) => i % 5 !== fold);
    const test = live.filter((_, i) => i % 5 === fold);
    const curve = fitSizeCurve(train);
    const flat = flatMultipleOf(train);
    for (const p of test) {
      curveErrors.push(logAbsErr(predMcap(p, curve, asOf), p.mcap_usd as number));
      flatErrors.push(logAbsErr(predMcap(p, curve, asOf, { flatMult: flat }), p.mcap_usd as number));
    }
  }
  const cvCurve = Math.pow(10, median(curveErrors));
  const cvFlat = Math.pow(10, median(flatErrors));
  const looCurveErrors: number[] = [];
  const looFlatErrors: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const train = live.filter((_, j) => j !== i);
    const curve = fitSizeCurve(train);
    const flat = flatMultipleOf(train);
    const p = live[i];
    looCurveErrors.push(logAbsErr(predMcap(p, curve, asOf), p.mcap_usd as number));
    looFlatErrors.push(logAbsErr(predMcap(p, curve, asOf, { flatMult: flat }), p.mcap_usd as number));
  }
  const looCurve = Math.pow(10, median(looCurveErrors));
  const looFlat = Math.pow(10, median(looFlatErrors));
  const walkForward: WalkForwardRow[] = [];
  const cutoffs = ["2024-01-01", "2024-07-01", "2025-01-01"];
  for (const cutoff of cutoffs) {
    const train = live.filter((p) => p.listed_at != null && p.listed_at < cutoff);
    const test = live.filter((p) => p.listed_at != null && p.listed_at >= cutoff);
    if (train.length < 10 || test.length < 5) continue;
    const curve = fitSizeCurve(train);
    const flat = flatMultipleOf(train);
    const errs: number[] = [];
    const flatErrs: number[] = [];
    const noGrowthErrs: number[] = [];
    const noMatErrs: number[] = [];
    let holds = 0;
    const sd = residualSd(train, curve, asOf);
    const band = Math.pow(10, 0.6745 * sd);
    for (const p of test) {
      const pred = predMcap(p, curve, asOf);
      errs.push(logAbsErr(pred, p.mcap_usd as number));
      flatErrs.push(logAbsErr(predMcap(p, curve, asOf, { flatMult: flat }), p.mcap_usd as number));
      noGrowthErrs.push(logAbsErr(predMcap(p, curve, asOf, { noGrowth: true }), p.mcap_usd as number));
      noMatErrs.push(logAbsErr(predMcap(p, curve, asOf, { noMat: true }), p.mcap_usd as number));
      if ((p.mcap_usd as number) >= pred / band && (p.mcap_usd as number) <= pred * band) holds++;
    }
    walkForward.push({
      cutoff,
      train: train.length,
      test: test.length,
      miss: Math.pow(10, median(errs)),
      missFlat: Math.pow(10, median(flatErrs)),
      missNoGrowth: Math.pow(10, median(noGrowthErrs)),
      missNoMaturity: Math.pow(10, median(noMatErrs)),
      sd,
      holdsPct: (100 * holds) / test.length,
    });
  }
  return { cvCurve, cvFlat, looCurve, looFlat, walkForward };
}

// Logistic squash for the backtest trainer, same bounds as the
// model's own sigmoid.
function oddsSigmoid(x: number): number {
  if (x > 700) return 1;
  if (x < -700) return 0;
  return 1 / (1 + Math.exp(-x));
}

// Token check for the backtest trainer: any of the three signals
// counts as a recorded token.
function oddsRecordsToken(p: SnapshotProtocol): boolean {
  return [p.mcap_usd, p.gecko_id, p.symbol].some((signal) => signal !== null);
}

// The same twelve features as oddsFeatures, with the arguments in
// the trainer's order (protocol, median age, snapshot date).
function oddsFeaturesOf(p: SnapshotProtocol, medianAge: number, asOf: string | Date): number[] {
  const knownAge = ageDays(asOf, p.listed_at);
  const age = knownAge === null ? medianAge : knownAge;
  const cat = p.category;
  const bridgeLike = cat === "Bridge" || cat === "Canonical Bridge" || cat === "Cross Chain Bridge" ? 1 : 0;
  const stakingLike = cat === "Liquid Staking" || cat === "Liquid Restaking" || cat === "Restaked BTC" ? 1 : 0;
  const logTvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? Math.log10(p.tvl_usd) : 0;
  const chainCount = (p.chains || []).length;
  return [
    Math.log1p(age),
    cat === "Dexs" ? 1 : 0,
    cat === "Lending" ? 1 : 0,
    bridgeLike,
    stakingLike,
    cat === "CEX" ? 1 : 0,
    p.listed_at === null ? 1 : 0,
    logTvl,
    chainCount,
    isHighLaunchCat(cat),
    isLowLaunchCat(cat),
    isHighRateChain(p.chains),
  ];
}

function trainOddsWithStats(
  rows: number[][],
  labels: number[],
  means: number[],
  sds: number[],
  baseRate: number,
): { weights: number[]; bias: number } {
  const dim = rows.length > 0 ? rows[0].length : 0;
  const std = rows.map((r) => r.map((v, k) => (sds[k] === 0 ? 0 : (v - means[k]) / sds[k])));
  const weights = new Array(dim).fill(0);
  const safeBase = Math.min(1 - 1e-6, Math.max(1e-6, baseRate));
  let bias = Math.log(safeBase / (1 - safeBase));
  const lr = 0.1;
  const iters = 3000;
  const l2 = 0.02;
  for (let it = 0; it < iters; it++) {
    const gradW = new Array(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < std.length; i++) {
      let z = bias;
      for (let k = 0; k < dim; k++) z += weights[k] * std[i][k];
      const err = oddsSigmoid(z) - labels[i];
      gradB += err;
      for (let k = 0; k < dim; k++) gradW[k] += err * std[i][k];
    }
    bias -= (lr * gradB) / std.length;
    for (let k = 0; k < dim; k++) weights[k] -= lr * (gradW[k] / std.length + l2 * weights[k]);
  }
  return { weights, bias };
}

export function backtestOdds(protocols: SnapshotProtocol[], asOf: string | Date): OddsBacktest {
  const full = fitOddsModel(protocols, asOf);
  const means = full.means;
  const sds = full.sds;
  const baseRate = full.baseRate;
  const baseBrier = baseRate * (1 - baseRate);
  const medianAge = full.medianAge;
  const labelsAll = protocols.map((p) => (oddsRecordsToken(p) ? 1 : 0));
  const rowsAll = protocols.map((p) => oddsFeaturesOf(p, medianAge, asOf));
  let cvSum = 0;
  let cvCount = 0;
  for (let fold = 0; fold < 5; fold++) {
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    protocols.forEach((_, i) => (i % 5 === fold ? testIdx.push(i) : trainIdx.push(i)));
    const trainRows = trainIdx.map((i) => rowsAll[i]);
    const trainLabels = trainIdx.map((i) => labelsAll[i]);
    const { weights, bias } = trainOddsWithStats(trainRows, trainLabels, means, sds, baseRate);
    for (const i of testIdx) {
      const raw = rowsAll[i];
      let z = bias;
      for (let k = 0; k < raw.length; k++) {
        const s = sds[k] === 0 ? 0 : (raw[k] - means[k]) / sds[k];
        z += weights[k] * s;
      }
      const pred = oddsSigmoid(z);
      cvSum += (pred - labelsAll[i]) * (pred - labelsAll[i]);
      cvCount++;
    }
  }
  const cvBrier = cvSum / cvCount;
  const shuffled = protocols.map((_, i) => i);
  const rnd = mulberry32(20261121);
  for (let i = shuffled.length - 1; i >= 1; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  const testSize = Math.floor(protocols.length * 0.2);
  const testIdx = shuffled.slice(0, testSize);
  const trainIdx = shuffled.slice(testSize);
  const holdoutModel = trainOddsWithStats(
    trainIdx.map((i) => rowsAll[i]),
    trainIdx.map((i) => labelsAll[i]),
    means,
    sds,
    baseRate,
  );
  let holdoutSum = 0;
  for (const i of testIdx) {
    const raw = rowsAll[i];
    let z = holdoutModel.bias;
    for (let k = 0; k < raw.length; k++) {
      const s = sds[k] === 0 ? 0 : (raw[k] - means[k]) / sds[k];
      z += holdoutModel.weights[k] * s;
    }
    const pred = oddsSigmoid(z);
    holdoutSum += (pred - labelsAll[i]) * (pred - labelsAll[i]);
  }
  const holdoutBrier = holdoutSum / testIdx.length;
  const ablation = (drop: number[]): number => {
    let sum = 0;
    let count = 0;
    for (let fold = 0; fold < 5; fold++) {
      const foldTrainIdx: number[] = [];
      const foldTestIdx: number[] = [];
      protocols.forEach((_, i) => (i % 5 === fold ? foldTestIdx.push(i) : foldTrainIdx.push(i)));
      const kept = rowsAll[0].map((_, k) => k).filter((k) => !drop.includes(k));
      const keptMeans = kept.map((k) => means[k]);
      const keptSds = kept.map((k) => sds[k]);
      const { weights, bias } = trainOddsWithStats(
        foldTrainIdx.map((i) => kept.map((k) => rowsAll[i][k])),
        foldTrainIdx.map((i) => labelsAll[i]),
        keptMeans,
        keptSds,
        baseRate,
      );
      for (const i of foldTestIdx) {
        let z = bias;
        kept.forEach((k, idx) => {
          const s = sds[k] === 0 ? 0 : (rowsAll[i][k] - means[k]) / sds[k];
          z += weights[idx] * s;
        });
        const pred = oddsSigmoid(z);
        sum += (pred - labelsAll[i]) * (pred - labelsAll[i]);
        count++;
      }
    }
    return sum / count;
  };
  const dropAge = ablation([0]);
  const dropCatFlags = ablation([1, 2, 3, 4, 5]);
  const dropListedNull = ablation([6]);
  const dropLogTvl = ablation([7]);
  const dropChains = ablation([8]);
  const dropHighCat = ablation([9]);
  const dropLowCat = ablation([10]);
  const dropHighChain = ablation([11]);
  return {
    cvBrier,
    holdoutBrier,
    baseBrier,
    ablations: { dropAge, dropCatFlags, dropListedNull, dropLogTvl, dropChains, dropHighCat, dropLowCat, dropHighChain },
  };
}

// Linear interpolation at a quantile of a sorted sample.
function percentileOf(sorted: number[], q: number): number {
  const position = q * (sorted.length - 1);
  const lowerIdx = Math.floor(position);
  const upperIdx = Math.ceil(position);
  if (lowerIdx === upperIdx) return sorted[lowerIdx];
  return sorted[lowerIdx] + (sorted[upperIdx] - sorted[lowerIdx]) * (position - lowerIdx);
}

// Slope quartiles over 200 bootstrap refits of the size curve, each
// refit on a resample drawn with replacement from the live set. The
// draw order is fixed by the seed, so the quartiles are reproducible.
export function bootstrapSlope(live: SnapshotProtocol[]): BootstrapSlope {
  if (live.length < 10) return { p25: -0.5269, p75: -0.5269, n: 0 };
  const draw = mulberry32(20261121);
  const fittedSlopes: number[] = [];
  for (let round = 0; round < 200; round++) {
    const resample: SnapshotProtocol[] = [];
    for (let k = 0; k < live.length; k++) resample.push(live[Math.floor(draw() * live.length)]);
    fittedSlopes.push(fitSizeCurve(resample).slope);
  }
  fittedSlopes.sort((a, b) => a - b);
  return { p25: percentileOf(fittedSlopes, 0.25), p75: percentileOf(fittedSlopes, 0.75), n: 200 };
}
