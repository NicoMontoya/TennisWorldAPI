# TennisWorld

Tennis analytics platform for fans — live scores, tournament draws with an interactive
bracket maker, win-probability predictions, ATP/WTA rankings, H2H analytics, and user
accounts with favorites. Vanilla HTML/CSS/JS frontend served by a Cloudflare Worker.

**Live:** https://tennisworld-api.nicomontoya.workers.dev

## Architecture

One Cloudflare Worker (`tennisworld-api`) serves everything:

- `/*` — static frontend from the sibling `../TennisWorldUI` directory (assets binding)
- `/api/*` — JSON API (this repo, `src/`)
- KV (`TENNIS_CACHE`) — response cache, user accounts, sessions, favorites, rate-limit counters
- Cron (every 6h) — warms standings + calendar caches, seeds rank snapshots
- Upstreams: [api-tennis.com](https://api-tennis.com) (live data), RapidAPI (historical rankings backfill)

The frontend picks its API base automatically: same-origin in production, `localhost:8787`
when a local static server (any port other than 8787) is used during development.

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

## Free-tier quota watch items

- **KV writes: 1,000/day.** Each cache fill, prediction cache, account write, and
  rate-limit tick is a write. A model auto-fill of a 128-draw caches ~127 predictions
  (shared across users — keys are per player-pair+surface). If traffic grows, the $5/mo
  Workers Paid plan raises this to 1M/day.
- **Requests: 100,000/day** on the free plan — plenty to start.
- **api-tennis.com plan limits** — the KV cache absorbs most load; watch the provider
  dashboard during Grand Slams.

## Security notes

- `/api/admin/*` routes require `ADMIN_SECRET` (secret, never a var) and fail closed when unset.
- Auth: PBKDF2 (100k iters, per-user salt), 30-day KV sessions, Bearer tokens.
- Register/login are rate-limited per IP (best-effort KV counter, 10 per 10 min).
- `.dev.vars` is git-ignored; no secrets in `wrangler.toml` or frontend JS.
