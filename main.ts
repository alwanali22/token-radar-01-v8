// Token Radar v8 — entrypoint, re-authored in this session.
// Reads the frozen snapshot, fits the L1HC model at runtime, ranks
// 198 pre-token protocols by implied value, prices a $2,000 farm
// plan for each, and writes board.json, data.js, dashboard/,
// screenshots/ and dossier.json. No network, stdlib only.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ageDays,
  backtestOdds,
  backtestValue,
  bootstrapSlope,
  calculateImpliedValue,
  farmEconomics,
  fitOddsModel,
  fitSizeCurve,
  generateFarmSteps,
  ledgerPartition,
  rankable,
  residualSd,
} from "./lib/model.ts";
import type { BoardRow, Snapshot, SnapshotProtocol } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

function fail(message: string): never {
  console.error(`token-radar: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = "/input";
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && i + 1 < argv.length) input = argv[++i];
    else if (arg === "--output" && i + 1 < argv.length) output = argv[++i];
  }
  if (!input.endsWith("snapshot.json")) input = join(input, "snapshot.json");
  return { input, output };
}

function loadSnapshot(path: string): Snapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read snapshot at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    fail(`snapshot at ${path} is not valid JSON`);
  }
  const snap = parsed as Snapshot;
  if (!Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist) || typeof snap.as_of !== "string") {
    fail("snapshot must carry protocols[], watchlist[] and as_of string");
  }
  for (const p of snap.protocols) {
    const ok =
      p !== null &&
      typeof p === "object" &&
      typeof p.slug === "string" &&
      typeof p.name === "string" &&
      (typeof p.category === "string" || p.category === null) &&
      Array.isArray(p.chains) &&
      typeof p.tvl_usd === "number";
    if (!ok) fail(`snapshot protocol ${JSON.stringify(p)} is malformed`);
  }
  return snap;
}

// FNV-1a 32-bit hex (8 chars) of the JSON of the first 250 rows.
function fnvHex(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hasToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

// Per-category calibration, computed from the snapshot itself:
// mean odds of this board's rows in the category vs the full-sample
// launch rate (protocols in the category that record a token).
function buildCalibration(rows: BoardRow[], protocols: SnapshotProtocol[]) {
  const byCat = new Map<string, { odds: number[]; full: number; launched: number }>();
  for (const p of protocols) {
    const cat = p.category ?? "(none)";
    const entry = byCat.get(cat) ?? { odds: [], full: 0, launched: 0 };
    entry.full += 1;
    if (hasToken(p)) entry.launched += 1;
    byCat.set(cat, entry);
  }
  for (const row of rows) {
    const entry = byCat.get(row.category);
    if (entry) entry.odds.push(row.odds);
  }
  const out: Array<{ category: string; nBoard: number; meanOdds: number; labelRate: number; gap: number }> = [];
  for (const [category, entry] of byCat) {
    if (entry.odds.length < 10) continue;
    const meanOdds = entry.odds.reduce((s, v) => s + v, 0) / entry.odds.length;
    const labelRate = entry.full > 0 ? entry.launched / entry.full : 0;
    out.push({ category, nBoard: entry.odds.length, meanOdds, labelRate, gap: meanOdds - labelRate });
  }
  out.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  return out;
}

// The falsifiable check the research note states: giant Risk
// Curators (TVL >= $500M) launching a token would prove the
// low-launch-category flag wrong. Counted from the snapshot: 0 of 4.
function buildFalsification(protocols: SnapshotProtocol[]) {
  const giants = protocols.filter((p) => p.category === "Risk Curators" && p.tvl_usd >= 500_000_000);
  return {
    riskCuratorsGiant: {
      total: giants.length,
      launched: giants.filter((p) => hasToken(p)).length,
    },
  };
}

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snap = loadSnapshot(input);
  const protocols = snap.protocols;
  const asOf = snap.as_of;

  const live = protocols.filter((p) => Number.isFinite(p.mcap_usd as number) && (p.mcap_usd as number) > 0 && p.tvl_usd > 0);
  const curve = fitSizeCurve(live);
  const oddsModel = fitOddsModel(protocols, asOf);
  const sd = residualSd(live, curve, asOf);
  const valueBacktest = backtestValue(live, asOf);
  const oddsBacktest = backtestOdds(protocols, asOf);
  const bootstrap = bootstrapSlope(live);
  const ledger = ledgerPartition(protocols);

  // Board: watchlist rankable protocols first, then the other
  // rankable ones, in snapshot order; the sort below decides ranks.
  const watchlistSet = new Set(snap.watchlist);
  const candidates = protocols.filter((p) => rankable(p));
  const ordered = [
    ...candidates.filter((p) => watchlistSet.has(p.slug)),
    ...candidates.filter((p) => !watchlistSet.has(p.slug)),
  ];
  const rows: BoardRow[] = ordered.map((p) => {
    const detail = calculateImpliedValue(p, asOf, curve, oddsModel, sd);
    const farm = farmEconomics(p, detail.implied);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? "(none)",
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(asOf, p.listed_at),
      watchlist: watchlistSet.has(p.slug),
      rank: 0,
      implied_value_usd: detail.implied,
      size_multiple: detail.sizeMultiple,
      growth_mult: detail.growthMult,
      maturity_mult: detail.maturityMult,
      odds: detail.odds,
      value_if_launches: Math.round(detail.valueIfLaunches),
      range_lo: detail.rangeLo,
      range_hi: detail.rangeHi,
      verdict: farm.verdict,
      net_usd: Math.round(farm.netUsd * 100) / 100,
      net_per_hour: Math.round(farm.netPerHour * 100) / 100,
      gas_usd: Math.round(farm.gasUsd * 100) / 100,
      farm_steps: generateFarmSteps(p, asOf),
    };
  });
  rows.sort((a, b) => (b.implied_value_usd - a.implied_value_usd) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  // Live tokens: finite market cap above zero, top 24 by market cap.
  const liveSorted = [...live].sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number));
  const liveTop = liveSorted.slice(0, 24).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    chains: p.chains,
  }));
  const liveAll = liveSorted.map((p) => ({
    slug: p.slug,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    category: p.category,
  }));

  // ---- gates: fail with a clear message and exit 1 if any trips ----
  if (rows.length < 100) fail(`board has ${rows.length} rows, need at least 100`);
  if (snap.watchlist.length !== 40) fail(`watchlist has ${snap.watchlist.length} slugs, need exactly 40`);
  const boardSlugs = new Set(rows.map((r) => r.slug));
  for (const slug of snap.watchlist) {
    if (!boardSlugs.has(slug)) fail(`watchlist slug ${slug} is missing from the board`);
  }
  if (boardSlugs.size !== rows.length) fail("a slug repeats on the board");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.rank !== i + 1) fail(`rank at position ${i} is ${row.rank}, expected ${i + 1}`);
    if (i > 0 && row.implied_value_usd > rows[i - 1].implied_value_usd) fail("implied value rises down the board");
    if (row.farm_steps.length !== 6) fail(`${row.slug} has ${row.farm_steps.length} farm steps, need 6`);
    for (const step of row.farm_steps) {
      if (typeof step !== "string" || step.trim().length < 20 || step.trim().length > 600) {
        fail(`${row.slug} has a farm step outside 20-600 characters`);
      }
    }
    if (!(row.odds >= 0.001 && row.odds <= 0.999)) fail(`${row.slug} odds ${row.odds} outside [0.001, 0.999]`);
    if (row.range_lo < 1 || row.range_hi <= row.range_lo) fail(`${row.slug} range is invalid`);
    if (!["FARM", "MARGINAL", "THIN", "SKIP"].includes(row.verdict)) fail(`${row.slug} verdict ${row.verdict} is invalid`);
  }
  const setAsideTotal = ledger.setAside.reduce((s, e) => s + e.count, 0);
  if (ledger.ranked + ledger.tokenTrades + setAsideTotal !== protocols.length) {
    fail(`ledger ${ledger.ranked}+${ledger.tokenTrades}+${setAsideTotal} does not sum to ${protocols.length}`);
  }
  if (liveTop.length !== 24) fail(`live list has ${liveTop.length} entries, need exactly 24`);
  if (valueBacktest.walkForward.length === 0) fail("walk-forward backtest produced no splits");

  // ---- outputs ----
  mkdirSync(output, { recursive: true });
  const first250 = rows.slice(0, 250);
  writeFileSync(join(output, "board.json"), JSON.stringify({ rows: first250 }, null, 2) + "\n", "utf8");
  const verdictCounts: Record<string, number> = { FARM: 0, MARGINAL: 0, THIN: 0, SKIP: 0 };
  for (const row of rows) verdictCounts[row.verdict] = (verdictCounts[row.verdict] ?? 0) + 1;
  const calibration = buildCalibration(rows, protocols);
  const falsification = buildFalsification(protocols);
  const radar = {
    rows: first250,
    live: liveTop,
    liveAll,
    model: {
      as_of: asOf,
      checksum: fnvHex(JSON.stringify(first250)),
      formula:
        "implied = TVL x size multiple (infra intercept) x growth x maturity x launch odds (no haircut); odds add log-TVL + chain count + grouped category flags + high-rate-chain flag; range = implied x 10^(+/-0.6745 x residual SD)",
      curve,
      odds: {
        weights: oddsModel.weights,
        bias: oddsModel.bias,
        means: oddsModel.means,
        sds: oddsModel.sds,
        baseRate: oddsModel.baseRate,
        medianAge: oddsModel.medianAge,
        cvBrier: oddsBacktest.cvBrier,
        holdoutBrier: oddsBacktest.holdoutBrier,
        baseBrier: oddsBacktest.baseBrier,
        ablations: oddsBacktest.ablations,
      },
      residualSd: sd,
      backtest: {
        value: valueBacktest,
        odds: oddsBacktest,
        bootstrap,
      },
      ledger,
      calibration,
      falsification,
      farmAssumptions: {
        deposit: 2000,
        horizonDays: 90,
        dropShare: 0.1,
        tbillRate: 0.045,
        hoursPerPlan: 2.7,
        feesUsdPerTx: {
          Ethereum: 4.5,
          Arbitrum: 0.15,
          Base: 0.05,
          BSC: 0.15,
          Solana: 0.02,
          Optimism: 0.1,
          Polygon: 0.05,
          Avalanche: 0.3,
          default: 0.5,
          bridge: 2.0,
        },
      },
      verdictCounts,
    },
    counts: {
      total: protocols.length,
      watchlist: snap.watchlist.length,
      board: rows.length,
      early: rows.filter((r) => !r.watchlist).length,
      live: liveTop.length,
      excluded: setAsideTotal,
    },
  };
  writeFileSync(join(output, "data.js"), `window.RADAR = ${JSON.stringify(radar)};\n`, "utf8");

  const here = new URL(".", import.meta.url).pathname;
  copyTree(join(here, "dashboard"), join(output, "dashboard"));
  copyTree(join(here, "screenshots"), join(output, "screenshots"));
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, "dossier.json"), dossier);

  const wf = valueBacktest.walkForward[0];
  const farmCount = verdictCounts.FARM ?? 0;
  console.log(
    `rows=${rows.length} top=${rows[0].slug} implied=${rows[0].implied_value_usd} ` +
      `wf2024=${wf.miss.toFixed(2)} brier=${oddsBacktest.cvBrier.toFixed(4)} ` +
      `holds=${wf.holdsPct.toFixed(1)} farm=${farmCount}`,
  );
}

main();
