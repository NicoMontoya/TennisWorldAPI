# ATP Sackmann backfill runbook

ATP-only. Do not invent rankings. WTA is out of scope.

Data: Jeff Sackmann CSVs from https://github.com/Kadantte/tennis_atp  
Local clone (Nico): `../tennis_atp` next to `TennisWorldAPI`.

Production Worker: `https://tennisworld-api.nicomontoya.workers.dev`

`wrangler dev` uses a **local** KV simulation. Writes only reach production KV when the scripts target the deployed Worker (`--worker` / `WORKER_URL`). `wrangler dev --remote` also hits real KV — do not use it for these imports unless you intend that.

## Hypotheses (verified 2026-09-07 against production)

| Id | Claim | Result |
|----|--------|--------|
| H1 | Paths exist but were never backfilled / production targeting was localhost-only | **Confirmed.** `GET /api/rankings-history?tour=ATP` → 404 `No historical rankings loaded`. `GET /api/player-vintage?playerKey=s103819` → `error: not-loaded`. Active `GET /api/player-ranking-history` only has cron snapshots (a few days), not career arcs. Scripts hardcoded `http://127.0.0.1:8787`. |
| H2 | Inactive keys (`s`+SackmannId) need polish for vintage | **Confirmed.** GET already branched on `s…` but `startsWith('s')` was too loose, and legend KV used a 400-day TTL (Time Machine years used 30d). Both would empty public GET after expiry. |

## What each script writes

Free-tier KV **writes: 1,000/day**. Reads are free. Imports are idempotent (re-run merges / overwrites).

| Script | Public GET | KV keys | Est. ATP writes |
|--------|------------|---------|-----------------|
| `backfill-rankings-history.ts` | `/api/rankings-history` (Time Machine weekly lists) | 1 key/year + 1 index | **~55** (1973→current, top 200). Intermediate years skip the index; the last POST writes the full date list. |
| `backfill-vintage-legends.ts` | `/api/vintage-roster`, `/api/player-vintage?playerKey=s…` | 1 key/legend + 1 index | **~183** at `--min 300` (~182 curves + index). Dry-run prints the exact count. |
| `backfill-sackmann.ts` | `/api/player-ranking-history` (career rank arcs) | 1 key per **name-matched** ranked player | **1 × matched roster**. Production standings is ~900 ATP names; expect a few hundred–900 writes. Use `--limit` / `--offset` if the dry-run estimate is >800. |

Do **not** run all three for real on the same UTC day if the sackmann dry-run estimate plus ~240 (Time Machine + vintage) would exceed 1,000.

Suggested split:

1. Day 1 — Time Machine + vintage (~240 writes).
2. Day 2 — career rank arcs (or `--limit 500` then `--offset 500` the next day).

`--dry` builds payloads and prints the write estimate; it does **not** POST. `backfill-sackmann.ts --dry` still **GET**s `/api/standings` (read-only) so the match count is real.

## Prereqs (Nico's machine)

```bash
cd /path/to/TennisWorldAPI
test -f ../tennis_atp/atp_players.csv && test -d ../tennis_atp || \
  git clone https://github.com/Kadantte/tennis_atp.git ../tennis_atp

# Production admin secret (same value as `wrangler secret put ADMIN_SECRET`)
export ADMIN_SECRET='…'
export WORKER_URL='https://tennisworld-api.nicomontoya.workers.dev'
# optional alias: --worker "$WORKER_URL" on each command
```

`--dry` does not need `ADMIN_SECRET`. A real run reads `ADMIN_SECRET` from the environment, else `.dev.vars`.

## Dry-run (no KV writes)

```bash
cd TennisWorldAPI

bun run scripts/backfill-rankings-history.ts --tour ATP --top 200 --dry \
  --worker https://tennisworld-api.nicomontoya.workers.dev

bun run scripts/backfill-vintage-legends.ts --tour ATP --min 300 --dry \
  --worker https://tennisworld-api.nicomontoya.workers.dev

# Still hits GET /api/standings on the Worker (no writes)
bun run scripts/backfill-sackmann.ts --tour ATP --dry \
  --worker https://tennisworld-api.nicomontoya.workers.dev
```

Confirm each dry-run prints `Estimated KV writes: N` and a Federer / 1985 sample where shown. If tennis_atp is not a sibling, pass `--data-dir /path/to/tennis_atp`.

## Real import (production KV)

```bash
cd TennisWorldAPI
export ADMIN_SECRET='…'   # production secret
export WORKER_URL='https://tennisworld-api.nicomontoya.workers.dev'

bun run scripts/backfill-rankings-history.ts --tour ATP --top 200
bun run scripts/backfill-vintage-legends.ts --tour ATP --min 300

# If dry-run estimated >800 writes, split:
bun run scripts/backfill-sackmann.ts --tour ATP --limit 500
# next UTC day:
bun run scripts/backfill-sackmann.ts --tour ATP --offset 500 --limit 500
# else:
bun run scripts/backfill-sackmann.ts --tour ATP
```

Local KV (optional, does **not** fill production):

```bash
npx wrangler dev   # :8787, local KV
export ADMIN_SECRET='…'   # from .dev.vars
bun run scripts/backfill-rankings-history.ts --tour ATP --dry
# omit --worker to default to http://127.0.0.1:8787
```

## Verification

```bash
BASE=https://tennisworld-api.nicomontoya.workers.dev

# Time Machine: meta + a known week (Wimbledon 2001 fortnight)
curl -sS "$BASE/api/rankings-history?tour=ATP&meta=1" | head -c 400
# expect ok, min ~1973-08-27, max in the current year, count ~2300+
curl -sS "$BASE/api/rankings-history?tour=ATP&date=2001-07-09&limit=5"
# expect Ivanisevic / Hewitt-era names — not invented, from the CSV

# Career rank arc (Sinner is RapidAPI 47275 on prod standings)
curl -sS "$BASE/api/player-ranking-history?tour=ATP&playerKey=47275"
# expect hundreds of weeks, first date in his junior/early career, not only today

# Vintage legends (Federer = Sackmann 103819)
curl -sS "$BASE/api/player-vintage?tour=ATP&playerKey=s103819"
# expect totals.slams=20, points.length in the thousands, no error: not-loaded
curl -sS "$BASE/api/vintage-roster?tour=ATP" | python3 -c \
  "import sys,json; r=json.load(sys.stdin)['data']['roster']; print(len(r), sum(1 for x in r if x.get('legend')))"
# expect roster >100 and legends >0 (s-prefixed ids)
```

Auth check (must stay 401 without the secret):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/admin/import-vintage" \
  -H 'Content-Type: application/json' -d '{"tour":"ATP","curves":{}}'
# 401
```

## If a run dies mid-way

- Re-run the same command. Imports overwrite / merge; they do not invent extra rankings.
- `KV put() limit exceeded` → stop. Wait until the next UTC day. Resume sackmann with `--offset` past the last successful batch (40 players per POST).
- Time Machine: if the last year never POSTed, the index is missing and GET still 404s even though year keys exist. Re-run the script (last year writes the full `indexDates` list).
