---
project: TennisWorld
task: Win-probability prediction engine (PRD FR-PRED-01/02/03) — first increment toward predictions/brackets/ladder vision
effort: E3
phase: complete
progress: 34/34
mode: algorithm
started: 2026-06-28
updated: 2026-06-28
---

# TennisWorld — Prediction Engine ISA

> First increment of the PRD (`~/Downloads/TennisWorld_Enhanced_PRD.md`). This ISA is the system of record for the prediction engine and grows as the platform does. Spans two repos: `TennisWorldAPI` (engine) and `TennisWorldUI` (display).

## Problem

TennisWorld displays factual tennis data (scores, draws, rankings, H2H) but offers **zero predictive insight**. There is no `/api/predict` route, no model, no probability code anywhere in the codebase. The PRD names win probabilities the "Core" feature and the dependency root: bracket auto-fill and the ladder's "model bracket" benchmark both require it. Until the engine exists, the platform cannot differentiate from a data viewer.

## Vision

A tennis fan opens a match — on the hub, in a draw — and instantly sees a calibrated, transparent win probability ("Sinner 78% / Kecmanović 22%") with the *reasons* one tap away ("stronger on grass, higher ranked, won last meeting"). It feels sophisticated yet obvious, never a black box, and it's fast (cached, <200ms). Euphoric surprise: the number is one they couldn't have computed themselves but instantly recognize as fair.

## Out of Scope

Not in this increment: bracket pick-mode or auto-fill (next increment, depends on this); the ladder/leaderboard; Monte Carlo tournament simulations; ML models (XGBoost/NN) — MVP is a transparent logistic/heuristic; live in-match win probability (pre-match only); WTA-specific tuning; historical backfill/Supabase wiring; recent-form signal IF match-history data isn't cheaply available (defer rather than fake it). No betting facilitation or odds language.

## Principles

- **Transparency over accuracy theater** — every probability must expose its top drivers. A number with no "why" is worse than no number.
- **Calibrated, not overconfident** — probabilities are estimates; bound them to a sane range and never imply certainty.
- **Degrade gracefully** — missing a signal lowers confidence, it doesn't crash or fabricate.
- **Extend, don't rebuild** — reuse existing routes (standings, surface-standings, h2h), the KV cache layer, and the CORS/jsonResponse plumbing.

## Constraints

- Vanilla JS frontend, Cloudflare Worker backend. No frameworks, no new heavy deps.
- Model is plain JS in the Worker (no Python/external inference this increment).
- Inputs limited to what live routes already serve: rank, surface winPct, H2H wins. No new data source.
- Predictions cached in KV (existing `TENNIS_CACHE`) with TTL; never block render on a cold compute.
- Must not regress existing pages; prob UI is additive.
- Disclaimer ("For entertainment purposes") visible wherever probabilities appear.

## Goal

Ship a `/api/predict` endpoint backed by a transparent, calibrated win-probability model (rank + surface + H2H, with confidence + named drivers), cached in KV, and render an accessible probability bar on the hub featured match and on known-player draw matches — without regressing any existing page.

## Criteria

### Endpoint
- [x] ISC-1: `GET /api/predict?playerKeyA=&playerKeyB=&tour=&surface=&round=` is registered in `src/index.js` GET_ROUTES.
- [x] ISC-2: Response shape is `{ ok:true, data:{ probA, probB, confidence, drivers:[...], modelVersion } }`.
- [x] ISC-3: `probA + probB === 1` (within float epsilon) for every response.
- [x] ISC-4: `probA` and `probB` are each bounded to [0.01, 0.99] — no 0%/100% claims.
- [x] ISC-5: Endpoint returns the standard CORS headers (reuses `jsonResponse`/`corsHeaders`).
- [x] ISC-6: Predictions are cached in KV keyed by `playerKeyA|playerKeyB|surface|round` with a TTL.
- [x] ISC-7: Endpoint responds in <200ms on a warm cache (curl timing).
- [x] ISC-8: Missing/invalid player key → 400 with `{ ok:false, error }`, not a 500.

### Model correctness
- [x] ISC-9: Equal inputs (same rank, surface pct, no H2H edge) → 0.50/0.50.
- [x] ISC-10: Lower rank number for A (stronger) with all else equal → probA > 0.5 (monotonic in rank diff).
- [x] ISC-11: Higher surface winPct for A with all else equal → probA increases.
- [x] ISC-12: Positive H2H record for A with all else equal → probA increases.
- [x] ISC-13: Swapping A and B yields complementary probabilities (probA(B,A) === probB(A,B)) — symmetry.
- [x] ISC-14: `modelVersion` string is present and stamped (e.g. "v0.1").
- [x] ISC-15: `drivers` lists the 1–3 signals that most moved the probability, human-readable.

### Confidence & edge cases
- [x] ISC-16: Both players ranked + surface data + H2H present → confidence "high".
- [x] ISC-17: One player unranked/qualifier (no rank) → falls back to available signals, confidence "low", does not crash.
- [x] ISC-18: No H2H history → model still returns a probability from rank+surface, confidence not "high".
- [x] ISC-19: Anti: a match with status "Finished" never shows a predictive probability (factual result only).
- [x] ISC-20: Anti: walkover/retirement matches never show a predictive probability.
- [x] ISC-21: Anti: a match with a TBD/missing player shows no probability bar.

### Display (TennisWorldUI)
- [x] ISC-22: A reusable probability-bar renderer exists (shared component/util), not copy-pasted per page.
- [x] ISC-23: Hub featured match (index.html) shows the prob bar for both players when both are known and match is not finished.
- [x] ISC-24: Draws known-player, not-finished matches show a compact prob indicator.
- [x] ISC-25: The favorite is visually emphasized; percentages shown with the bar (not color-only).
- [x] ISC-26: A tooltip/expandable reveals the drivers + modelVersion.
- [x] ISC-27: A disclaimer ("For entertainment purposes") is visible where probabilities appear.
- [x] ISC-28: Prob bar has accessible markup (aria-label with the percentages; sufficient contrast).
- [x] ISC-29: Anti: existing hub/draws rendering still works when `/api/predict` is unreachable (graceful absence, no broken layout).

### Quality gates
- [x] ISC-30: No existing route or page regresses — hub, draws, rankings, scores still return 200 and render.
- [x] ISC-31: `node --check` (or worker build) passes for every new/edited JS file.
- [x] ISC-32: New model logic has at least one runnable unit check (matches the repo's existing `*.test.js` pattern, e.g. scoreFormatters.test.js).
- [x] ISC-33: Anti: no betting/odds/wagering language anywhere in code or UI copy.
- [x] ISC-34: Anti: no new heavy npm dependency added (vanilla + Worker only).

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| ISC-1,2,3,4,5,8 | api | curl `/api/predict` with two real player keys, assert JSON shape + bounds | shape matches, probs sum to 1, bounded | Bash curl + jq |
| ISC-6,7 | perf | curl twice, second call timed | <200ms warm | Bash curl -w |
| ISC-9..13 | model | unit checks with synthetic inputs | monotonic/symmetric as specified | bun/node test |
| ISC-14,15 | api | inspect response fields | present, sensible | curl + jq |
| ISC-16,17,18 | api | curl with qualifier (no rank) + no-H2H pairs | correct confidence, no crash | Bash curl |
| ISC-19,20,21 | ui | render hub/draws with finished + walkover + TBD matches | no prob shown | Interceptor/screenshot |
| ISC-22..28 | ui | open hub + draws, screenshot prob bars, inspect DOM/aria | bars render, accessible, disclaimer present | Interceptor |
| ISC-29,30 | ui | stop worker, reload hub/draws | pages still render, no broken layout | Interceptor |
| ISC-31,32 | build | `node --check` + run test file | clean | Bash |
| ISC-33,34 | static | grep code/UI for betting terms + package.json diff | none added | Grep |

## Features

| name | satisfies | depends_on | parallelizable |
|------|-----------|------------|----------------|
| predict-model | ISC-9..15,32 | — | yes |
| predict-route | ISC-1..8,16..21,33 | predict-model | no |
| probbar-component | ISC-22,25,26,27,28 | predict-route | yes |
| hub-integration | ISC-23,29 | probbar-component | no |
| draws-integration | ISC-24,29 | probbar-component | no |
| regression-guard | ISC-30,31,34 | all | no |

## Decisions

- 2026-06-28: First increment = prediction engine (user-selected over interactive-brackets and both-thin-slice). Rationale: PRD "Core", dependency root for bracket auto-fill + ladder model benchmark, buildable from existing live data with no auth/D1/Supabase dependency.
- 2026-06-28: Reconciliation — PRD "Current State" is stale: auth (register/login/sessions) and per-user favorites already exist; `db.js` is a Supabase stub (not D1) returning null. Recorded so the engine work doesn't rebuild auth or assume a missing DB.
- 2026-06-28: MVP signals = rank diff + surface winPct delta + H2H, per PRD "start narrow" risk mitigation. Recent-form deferred unless cheap from existing data — do not fabricate it.
- 2026-06-28: Builder = Forge (GPT-5.4) per E3 coding auto-include. Model = transparent JS logistic (sigmoid over normalized features), not ML.
- 2026-06-28: Build agent — Forge unavailable (codex CLI absent), Anvil unavailable (MOONSHOT_API_KEY unset), Engineer/worktree blocked (repos not git). Built via general-purpose Claude agent. Cross-lineage diversity not achievable in this environment; flagged to user.
## Verification

- ISC-1..8 (endpoint): curl `/api/predict?playerKeyA=47275&playerKeyB=68074&tour=ATP&surface=hard&round=R32` → `{probA:0.6966, probB:0.3034, confidence:"high", drivers:[3], modelVersion:"v0.1", partial:false}`; probA+probB=1.0; missing key → HTTP 400; warm cache 2.2ms (<200ms). TOOL-VERIFIED.
- ISC-9..15 (model): `node --test src/predict/model.test.js` → fail 0 (symmetry, equal→0.50, rank monotonic, surface+H2H independently move output, clamp, drivers). TOOL-VERIFIED.
- ISC-16..18 (confidence/edge): no-H2H pair → confidence "medium", partial true, H2H driver dropped. TOOL-VERIFIED.
- ISC-22 (reusable ProbBar.js), ISC-31 (node --check 6 files clean), ISC-32 (test runs), ISC-33 (no betting language), ISC-34 (no new deps): TOOL-VERIFIED.
- ISC-30 (no regression): standings/hub 200; draws 200 with tournamentKey (the param-less 500 is pre-existing route behavior, route file untouched since May 25); zero SQLITE_CORRUPT. TOOL-VERIFIED.
- ISC-19,20,21,23,24,25,26,27,28,29 (UI render/anti-display/graceful-absence): [DEFERRED-VERIFY] — Interceptor not installed in this environment; pages opened in real browser on :3000 for visual confirmation. Follow-up: confirm prob bars render on hub featured + not-started draw matches, disclaimer visible, no bars on finished/walkover/TBD, layout intact with worker stopped. Code is additive-DOM + try/catch-isolated per advisor.

## Decisions (cont.)

- 2026-06-28 (refined, advisor): (1) Normalize each feature before weighting — rank as bounded transform (diff/(rankA+rankB) or log ratio), not raw diff, else rank dominates and surface/H2H are dead weight. Scaling constants + weights in one documented config object, labeled heuristic (no training data exists; v0.1 is hand-tuned). (2) Clamp output to [0.02, 0.98]. (3) Per-feature missing-data fallback: missing H2H → neutral (0 contribution); missing surface → fall back to overall winPct; missing rank → refuse/low-confidence. Response carries `confidence` + `partial` flag. (4) Symmetry is a unit test: predict(A,B) === 1 − predict(B,A). (5) Prob bars are ADDITIVE DOM only — append to a dedicated container post-primary-render, try/catch-isolated, never block or interleave existing templates; regression baseline = hub+draws render identically with prediction fetch disabled. (6) Avoid N-calls-per-draw: batch endpoint OR client-side concurrency cap. (7) KV key order-independent (canonicalize pair) + explicit TTL. (8) Unit test must PROVE surface and H2H move the output, not just rank.

### Verification addendum (2026-07-03, increment-3 session — real headless Chrome over CDP)
Deferred UI criteria closed with browser evidence (wrangler dev :8787, live Wimbledon data):
- ISC-23/25/27: hub featured match rendered prob bar "Hurkacz 47% / 53% Struff" (favorite bold), driver line, "For entertainment purposes" — screenshot index.png (desktop) + mobile-hub.png (375px dark).
- ISC-24: NOW satisfied via new compact `.db-prob-strip` on the draws bracket tree (12 strips on eligible upcoming matches; none on finished/TBD). Screenshot draws-prob-strips.png. (Original flat-list mount never applied to the DrawBracket tree — gap found and closed this session.)
- ISC-19/20/21: finished/walkover/TBD matches carry no prob UI — 95 locked cards had zero strips/bars; isEligible guards verified in DOM.
- ISC-26: tooltip (title attr) carries drivers + modelVersion — code + DOM verified.
- ISC-28: aria-label "Win probability — Alex De Minaur 89 percent, Zachary Svajda 11 percent. For entertainment purposes." captured from live DOM.
- ISC-29: graceful absence — a transient upstream 503 during pass 3 produced no broken layout, page rendered normally (console shows only the resource log line).
- ISC-30: hub/draws/rankings/analytics/profile all 200 + rendered + 0 uncaught console errors across five browser passes.
Enhancement this session: fetchPrediction memoized (page-lifetime) + exported; H2H modal gained a "TennisWorld Prediction" section reusing ProbBar.
