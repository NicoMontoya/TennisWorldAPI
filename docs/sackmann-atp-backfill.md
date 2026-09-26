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
| `backfill-vintage-rank-by-age.ts` | `/api/vintage-rank-by-age` | 1 key per vintage-roster player | **1 × roster row actually joined** (top 100 + retired legends). Dry-run prints the count; expect well under 300. Unmatched / ambiguous names are not written. |

Do **not** run the Sackmann imports on the same UTC day if the sackmann dry-run estimate plus ~240 (Time Machine + vintage) would exceed 1,000. Rank-by-age is a later import, after `/api/vintage-rank-by-age` is deployed; do not stack it on a day that is already near the ceiling.

Suggested split:

1. Day 1 — Time Machine + vintage (~240 writes).
2. Day 2 — career rank arcs (or `--limit 500` then `--offset 500` the next day).
3. After the rank-by-age route is deployed — `backfill-vintage-rank-by-age.ts` (1 write per joined vintage-roster player, typically under 300).

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

# Rank-by-age is dry-run unless --write. Offline spot-check (no worker):
bun run scripts/backfill-vintage-rank-by-age.ts --tour ATP --ids s103819,s101948,s101736 --dry
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

# After this Worker deploy is live (do not run before the route exists).
# Default is dry-run. --write is 1 KV put per joined roster player.
bun run scripts/backfill-vintage-rank-by-age.ts --tour ATP --dry \
  --worker https://tennisworld-api.nicomontoya.workers.dev
bun run scripts/backfill-vintage-rank-by-age.ts --tour ATP --write
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

# Vintage rank-by-age (after backfill-vintage-rank-by-age.ts --write)
curl -sS "$BASE/api/vintage-rank-by-age?tour=ATP&playerKey=s103819"
# Federer: years include age 22 rank 1 and age 35 rank 4; no birthday field
curl -sS "$BASE/api/vintage-rank-by-age?tour=WTA&playerKey=s103819"
# available false, reason wta-ranking-history-not-loaded, years []
```

Auth check (must stay 401 without the secret):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/admin/import-vintage" \
  -H 'Content-Type: application/json' -d '{"tour":"ATP","curves":{}}'
# 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/admin/import-vintage-rank-by-age" \
  -H 'Content-Type: application/json' -d '{"tour":"ATP","records":{}}'
# 401
```

## Vintage rank-by-age response

`GET /api/vintage-rank-by-age?tour=ATP&playerKey=` uses the same `playerKey` as `/api/player-vintage`. Weeks are days the ranking stood ÷ 7, rounded to 1 decimal. The UI rounds those to whole numbers for the tooltip. `partial: true` only on the age year that contains `asOf`. Missing ages are omitted (do not draw a zero, do not connect across the gap). `ageAtRankingsStart` is the player's age on `rankingsStart`, or `null` if they were not born yet — the pre-1973 note applies only when a visible age is below that number. The payload never includes a birth date.

```json
{
  "tour": "ATP",
  "playerKey": "s103819",
  "name": "Roger Federer",
  "asOf": "2026-06-08",
  "rankingsStart": "1973-08-27",
  "ageAtRankingsStart": null,
  "available": true,
  "years": [
    { "age": 22, "rank": 1, "weeksAtRank": 26.9, "rankedWeeks": 52.3, "partial": false }
  ]
}
```

`reason` is present only when there is nothing to plot, or the tour is unavailable:

| `reason` | `available` | When |
|---|---|---|
| *(omitted)* | true | `years` has at least one point |
| `no-ranking-history` | true | No age year with ≥ 13 ranked weeks |
| `no-birthday` | true | Sackmann row has no date of birth |
| `not-loaded` | false | ATP calendar is loaded; this player has no precomputed record. `asOf` is the index max. |
| `rankings-not-loaded` | false | ATP weekly index itself is missing |
| `wta-ranking-history-not-loaded` | false | WTA. `years` is `[]`, `asOf` is null. No KV read. |

Cost: a warm GET is 0 KV reads and 0 writes (Cache API, 24h). A cold hit is 1 KV read and 0 writes. A miss is 2 KV reads (player key, then the rankings index) and 0 writes; misses are not edge-cached. The backfill is 1 permanent KV write per joined roster player (no TTL), batched 20 per admin POST. Re-run after a rankings-history refresh; do not stack it on a day that is already near 1,000 writes. Resume a partial `--write` with `--offset`.

## If a run dies mid-way

- Re-run the same command. Imports overwrite / merge; they do not invent extra rankings.
- `KV put() limit exceeded` → stop. Wait until the next UTC day. Resume sackmann with `--offset` past the last successful batch (40 players per POST). Resume rank-by-age the same way (`--offset`, 20 players per POST).
- Time Machine: if the last year never POSTed, the index is missing and GET still 404s even though year keys exist. Re-run the script (last year writes the full `indexDates` list).
