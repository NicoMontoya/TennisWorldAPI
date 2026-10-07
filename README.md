# TennisWorld

Tennis analytics platform for fans — live scores, tournament draws with an interactive
bracket maker, win-probability predictions, ATP/WTA rankings, H2H analytics, and user
accounts with favorites. Vanilla HTML/CSS/JS frontend served by a Cloudflare Worker.

**Live:** https://tennisworld-api.nicomontoya.workers.dev

## Architecture

One Cloudflare Worker (`tennisworld-api`) serves everything:

- `/*` — static frontend from the sibling `../TennisWorldUI` directory (assets binding)
- `/api/*` — JSON API (this repo, `src/`)
- KV (`TENNIS_CACHE`) — durable cache (rankings, vintage, match logs, auth, sessions, favorites). Not used for hub/livescore payloads.
- Cache API (`caches.default`) — hub/livescore public payloads + per-IP rate-limit counters (not KV)
- Cron (every 6h) — warms standings + calendar caches, seeds rank snapshots
- Upstreams: MatchStat / RapidAPI `tennis-api-atp-wta-itf` (live scores via Extend `/extend/api/events/live`, plus Core fixtures/rankings/draws). api-tennis.com remains for a few legacy routes (tournaments, surface standings) — not Scores live.

The frontend picks its API base automatically: same-origin in production, `localhost:8787`
when a local static server (any port other than 8787) is used during development.

### User brackets & leaderboard

Signed-in fans save one bracket per tournament (`POST /api/bracket/save`); guests keep
localStorage brackets. Endpoints: `/api/bracket/mine` (auth), `/api/bracket/leaders`,
`/api/bracket/public?id=` (both public — expose display name + random publicId, never
emails). Scoring is round-weighted (first delivered round = 1 pt, doubling each round,
so every round is worth the same total on a full draw); `maxPossible` drops picks whose
player has been eliminated. Anti point-farming: picks on already-decided matches are
locked to their previously-saved value at save time. Leaderboards recompute lazily with
a 5-minute KV cache (`_lb:*`) — no cron needed. Picks saved on projected rounds use
positional `__inf_{col}_{slot}` keys that keep scoring after the round materializes
(same fallback lives in `TennisWorldUI/components/BracketPicks.js` — keep in sync).

The pick UI is a **from-scratch canvas**: first-round pairings only, the fan predicts
every match themselves; real results grade picks (green/red) but never pre-fill them.
Picks first created on already-decided matches are stored with a `retro` flag —
displayed and comparable, but permanently excluded from scoring (late entrants can
complete their bracket without earning hindsight points).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars    # RAPIDAPI_KEY for Scores live + Core; TENNIS_API_KEY only for leftover api-tennis routes
npm run dev                  # serves UI + API at http://localhost:8787
```

## Tests

```bash
npx vitest run                          # transforms suite
node --test src/predict/model.test.js   # prediction model suite
# UI repo:
cd ../TennisWorldUI && npx vitest run && node --test components/BracketPicks.test.js
```

## Deploy runbook

One-time (already done for this account, repeat only on a new account):

```bash
npx wrangler kv namespace create TENNIS_CACHE   # put id in wrangler.toml
npx wrangler secret put RAPIDAPI_KEY            # MatchStat / Scores live + Core (existing secret)
npx wrangler secret put TENNIS_API_KEY          # leftover api-tennis.com routes only
npx wrangler secret put ADMIN_SECRET            # protects /api/admin/* (they 401 if unset)
```

Every deploy:

```bash
npx wrangler secret list        # confirm TENNIS_API_KEY (+ ADMIN_SECRET) exist in prod
npx wrangler deploy --dry-run   # sanity check bundle + config
npx wrangler deploy
npx wrangler tail               # live prod logs — keep open during launch-day smoke test
```

Note: `wrangler dev` uses a LOCAL KV simulation — dev/test writes (accounts,
rate-limit counters) never touch the production namespace. Only `wrangler dev
--remote` or a deployed Worker writes to the real KV.

Post-deploy verification:

```bash
BASE=https://tennisworld-api.nicomontoya.workers.dev
curl -s "$BASE/api/standings?tour=ATP" | head -c 200   # expect {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/"       # expect 200 (UI)
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/debug"  # expect 404 (removed)
```

Rollback: `npx wrangler rollback` (or redeploy the previous git tag).

After first deploy: run `curl "$BASE/api/admin/backfill-rankings?tour=ATP&weeksBack=26&secret=…"`
once so player-profile ranking charts have history immediately (cron keeps them fresh after).

ATP Sackmann historical data (career rank arcs, Time Machine weekly lists,
vintage legends, vintage rank-by-age) is **not** created by that RapidAPI week crawl. Load it from
the local `../tennis_atp` clone with the backfill scripts, targeting production
via `--worker` / `WORKER_URL` — see [docs/sackmann-atp-backfill.md](docs/sackmann-atp-backfill.md).
`/api/vintage-rank-by-age` reads one precomputed player record (Cache API after the first hit). The rank-by-age script is dry-run unless `--write`.
`wrangler dev` KV is local-only; localhost backfills never fill workers.dev.

## Free-tier quota watch items

- **KV writes: 1,000/day.** Durable cache fills (rankings, vintage, match logs),
  prediction cache, and account writes count. Hub/livescore payloads and
  rate-limit ticks use the Cache API, not KV — a live Scores tab polling
  `/api/livescore` every 15s does not spend the daily quota on match JSON,
  the fetch timestamp, or counters. The livescore fetch time stays on the
  edge entry and in isolate memory. Sticky-completion `:done` snapshots still
  write KV only when the completed-match set changes. If a cache `put` fails
  (quota / transient / Cache API), hub and livescore still return the freshly
  computed payload instead of 500ing. Auth register/login still use a KV
  counter (low volume). A model
  auto-fill of a 128-draw caches ~127 predictions (shared across users — keys
  are per player-pair+surface). If traffic grows, the $5/mo Workers Paid plan
  raises this to 1M/day.
- **Requests: 100,000/day** on the free plan — plenty to start.
- **RapidAPI / MatchStat plan limits** — Scores live uses the existing `RAPIDAPI_KEY`
  Worker secret (60s edge TTL while anything is live, scheduled, or delayed).
  Leftover api-tennis.com routes still use `TENNIS_API_KEY`.
- **`RAPIDAPI_HARD_STOP`** (`wrangler.toml` `[vars]`, ships as `off`). `on` stops
  new RapidAPI calls once quota is exhausted. A response that carries
  `x-ratelimit-requests-remaining` and is non-numeric, zero, or negative trips
  on any status. A 2xx with that header missing counts a per-location edge
  streak (not KV) and trips the shared flag at 3. The streak resets only on a
  2xx with a valid remaining count. Header-less non-2xx responses do not trip
  and do not change the streak. 429 always trips. Every fetch that is actually
  sent, including 5xx, increments a separate edge call tally. `off` never
  stops. `force` stops immediately, before any fetch. Unset is `off`. Only the exact strings `off`, `on`, and
  `force` are recognized; any other present value (blank, different case,
  trailing space, typo) acts as `on`. There is no route to change it. The
  shared flag is one KV write (`{until}`), read back through a 60s edge cache.
  The miss streak also stops that location locally at 3 (edge only). Reset
  seconds clamp to 60s–31 days; a missing reset rechecks in 24h. With the stop on, visitors get cached or stale rankings, draws, and
  results; live scores stay frozen on the last edge payload; pages with nothing
  cached return their usual empty body or a generic upstream 503. Responses
  never include the remaining count, the reset, or whether the stop is on.
  `GET /api/livescore` always sends `X-Fetched-At`, an ISO 8601 UTC string.
  Other methods (HEAD, POST) are not this route and do not send the header.
  A successful fill stores that Worker-clock time on the edge entry next to
  the payload, a 12h edge backup of that list, and in this isolate's memory.
  It is not written to KV. Cache hits, a hard stop, and an upstream error
  return that saved list and its original time. The empty list and
  `1970-01-01T00:00:00.000Z` are only used when no board was ever saved.
  The JSON body is
  unchanged (`data` stays the match array). The Scores page polls this
  route, not `/api/hub`, so the hub response does not carry the header.
  A cross-origin livescore response also lists that name in
  `Access-Control-Expose-Headers`.

## Security notes

- `/api/admin/*` routes require `ADMIN_SECRET` (secret, never a var) and fail closed when unset.
- Auth: PBKDF2 (100k iters, per-user salt), 30-day KV sessions, Bearer tokens.
- Register/login are rate-limited per IP (best-effort KV counter, 10 per 10 min).
- `GET /api/hub` and `GET /api/livescore` are rate-limited per IP via the Cache API (`https://rl.internal/{hub|livescore}/{ip}`, 60 per 60s). Livescore cache is 60s when matches are live, scheduled, or delayed, and 2 min only when the board is finished-only / empty; hub stays 5 min (live overlay from the livescore cache on hit). Auth register/login remain on a KV counter.
- `tour` on hub/livescore/draws is ATP|WTA only. `tournamentKey` on livescore/draws/fixtures is digits-only (`/^\d{1,20}$/`).
- `.dev.vars` is git-ignored; no secrets in `wrangler.toml` or frontend JS.
