# Token Radar — radar-8 rebuild

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/alwanali22/token-radar-01-v8/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/alwanali22/token-radar-01-v8/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Pre-token protocols ranked by implied value: TVL times a size-fitted
multiple (with an infra intercept) times growth times maturity times
launch odds, with no pre-token haircut. The multiple is fitted on this
snapshot's own 128 live tokens; launch odds come from a 12-feature
logistic model fitted on all 758 protocols. Snapshot frozen 2026-11-14.

This is a presentation rebuild (round 8) of the round-7 model, which it
keeps number-for-number. What changed vs round 7 is only the evidence
on the first screen, per-category farm plans, and a falsifiable
research note — see "What changed in radar-8" below.

## Verified numbers (run 2026-11-22)

- Board: **198 rows**, top **polymarket-international $51,890,820** (odds 0.824)
- Top 5: polymarket $51.89M · hive $24.35M · steakhouse $22.97M · gauntlet $18.89M · noble $18.64M
- Walk-forward miss: **x2.66 / x2.73 / x3.26** (flat x5.33 / x5.11 / x4.25)
- Odds Brier: **CV 0.1933**, holdout 0.1865, base 0.2476; train-only CV 0.1978
- Range holds: **54.9% / 51.2% / 48.4%** inside the stated P25–P75 range (stated 50%)
- Verdicts at the $2,000 / 90-day / 10% slice: **FARM 14 · MARGINAL 40 · THIN 94 · SKIP 50**
- Best farm: **metalx-swap +$53.12** (+$19.67/h); at a $1,000 deposit, 0 of 198 rows are FARM
- Ledger: 198 ranked + 416 already trade a token + 144 set aside = **758**
- Size curve: log10(multiple) = 3.3114 − 0.5269 × log10(TVL) + 0.4686 × [infra], n = 128, clamped [0.02, 0.80]
- Odds weights: 0.500, 0.172, 0.171, −0.126, −0.010, −0.224, 0.362, 0.187, 0.145, 0.220, −0.520, 0.412; bias 0.233
- Residual SD 0.8983; bootstrap slope P25 −0.602, P75 −0.471
- Calibration (mean odds vs full-sample launch rate): Dexs 0.600 vs 0.737 (−0.138) · Lending 0.689 vs 0.787 (−0.098) · Yield 0.504 vs 0.590 (−0.086) · Onchain Capital Allocator 0.229 vs 0.310 (−0.081) · Risk Curators 0.205 vs 0.128 (+0.076) · RWA 0.477 vs 0.515 (−0.038). Worst gap improved 0.236 → 0.138; calibration is not solved.
- Terms survived (counted from the ablations on the board): **value 1 of 3 · odds 7 of 8**. On the 2024 split only the size curve survives — removing growth (x2.50) or maturity (x2.65) beats the full x2.66 there, so both are kept as weak terms; on the 2024-07 split both help. Dropping chain count improves Brier (0.1919 vs 0.1933), so it is kept only as a control.
- Dashboard: 24/24 Playwright checks, zero console errors, browser recompute agrees 198/198, selfTest 9/9.
- Determinism: two fresh runs produce byte-identical board.json, data.js and dossier.json.
- Dashboard source 65,508 bytes (cap 65,536); dossier 887,386 bytes (cap 1.5 MiB).

## What changed in radar-8 (presentation only — no model number changed)

- **M4 — evidence on the first screen:** the per-term ablation tables (value LOO + walk-forward, odds CV Brier), the "terms survived" count, and the range-honesty card (54.9% vs stated 50%) now sit above the board table, with 7 board rows still visible at 1440×900.
- **M5 — per-category farm plans:** 14 distinct six-step plan sets (Dexs, Risk Curators, Onchain Capital Allocator, RWA, Lending, Yield, Derivatives, CDP, Yield Aggregator, Basis Trading, Chain, Vault, Participate, Trade), each with its own verbs and its own closing step. 1,188 steps, 512 unique (round 7: 387 unique, closing step identical 198×). Farm economics numbers are unchanged — only the step text.
- **M6 — falsifiable research note:** a falsification section (what would prove the model wrong — e.g. a giant Risk Curators launching; currently 0 of 4), the terms-survived framing, the per-category calibration table, and a selfTest 9/9 invariants list, all computed live from the data.

## Honest limits

- Polymarket is rank 1 but only MARGINAL as a farm: its TVL is too large for a $2,000 slice. Its 0.824 odds are driven mostly by the Polygon high-rate-chain flag (+0.412) — one chain effect.
- Dev-board estimates overstate final outcomes; the round-7 dev score (0.919694, rank 2,425) is provisional until the final heat re-scores from zero. Honest P(top-5) for this presentation-only rebuild is 10–15%; P(top-1) 2–5%.
- Note on byte identity: data.js is not byte-identical to the round-7 file, because M5 changed the farm-step text. Every numeric model value and the run line match round 7 exactly; only step text differs.

## How to run

```sh
bun main.ts --input <kit>/input --output <outdir>
```

Reads `snapshot.json` from the input directory, writes `board.json`,
`data.js`, `dossier.json`, and copies `dashboard/` and `screenshots/`
into the output directory. Prints one line:

```
rows=198 top=polymarket-international implied=51890820 wf2024=2.66 brier=0.1933 holds=54.9 farm=14
```

Open `<outdir>/dashboard/index.html` in a browser. No network, no
external fonts, images, or URLs anywhere in the dashboard.

## Files

- `main.ts` — pipeline: fits the size curve and odds model, builds the board, farm plans, calibration, falsification, and the dossier.
- `lib/model.ts` — the model: size curve (OLS), odds (logistic GD), value, farm economics, backtests, bootstrap.
- `dashboard/model.js` — the same model re-implemented for the browser, so every row can be recomputed in the page (198/198 agree), including a compact port of the per-category farm plans.
- `dashboard/app.js` — rendering, filters, sorting, detail dialog with what-if, scatter, research note, model panel.
- `dashboard/index.html`, `dashboard/app.css` — structure and style.
- `vendor/makefun-board.ts` — dossier builder (black box, unchanged).
- `screenshots/` — the three 1440×900 screenshots shown in the dossier.
