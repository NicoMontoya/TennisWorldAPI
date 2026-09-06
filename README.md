# TennisWorld

Tennis analytics platform for fans — live scores, tournament draws with an interactive
bracket maker, win-probability predictions, ATP/WTA rankings, H2H analytics, and user
accounts with favorites. Vanilla HTML/CSS/JS frontend served by a Cloudflare Worker.

**Live:** https://tennisworld-api.nicomontoya.workers.dev

## Architecture

One Cloudflare Worker (`tennisworld-api`) serves everything:

- `/*` — static frontend from the sibling `../TennisWorldUI` directory (assets binding)
- `/api/*` — JSON API (this repo, `src/`)
- KV (`TENNIS_CACHE`) — response cache, user accounts, sessions, favorites, auth rate-limit counters
- Cache API (`caches.default`) — hub/livescore per-IP rate-limit counters (not KV)
- Cron (every 6h) — warms standings + calendar caches, seeds rank snapshots
- Upstreams: [api-tennis.com](https://api-tennis.com) (live data), RapidAPI (historical rankings backfill)

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
cp .env.example .dev.vars    # then fill in TENNIS_API_KEY (and optionally RAPIDAPI_KEY, ADMIN_SECRET)
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
npx wrangler secret put TENNIS_API_KEY          # api-tennis.com key
npx wrangler secret put RAPIDAPI_KEY            # optional: rankings backfill
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

## Free-tier quota watch items

- **KV writes: 1,000/day.** Each cache fill, prediction cache, and account write
  is a write. Hub/livescore rate-limit ticks use the Cache API, not KV — a live
  Scores tab polling `/api/livescore` every 15s no longer spends the daily quota.
  Auth register/login still use a KV counter (low volume). A model auto-fill of a
  128-draw caches ~127 predictions (shared across users — keys are per
  player-pair+surface). If traffic grows, the $5/mo Workers Paid plan raises this
  to 1M/day.
- **Requests: 100,000/day** on the free plan — plenty to start.
- **api-tennis.com plan limits** — the KV cache absorbs most load; watch the provider
  dashboard during Grand Slams.

## Security notes

- `/api/admin/*` routes require `ADMIN_SECRET` (secret, never a var) and fail closed when unset.
- Auth: PBKDF2 (100k iters, per-user salt), 30-day KV sessions, Bearer tokens.
- Register/login are rate-limited per IP (best-effort KV counter, 10 per 10 min).
- `GET /api/hub` and `GET /api/livescore` are rate-limited per IP via the Cache API (`https://rl.internal/{hub|livescore}/{ip}`, 60 per 60s). Cache TTLs are unchanged. Auth register/login remain on a KV counter.
- `tour` on hub/livescore/draws is ATP|WTA only. `tournamentKey` on livescore/draws/fixtures is digits-only (`/^\d{1,20}$/`).
- `.dev.vars` is git-ignored; no secrets in `wrangler.toml` or frontend JS.
