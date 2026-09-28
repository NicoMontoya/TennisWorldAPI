# Data storage plan

Store RapidAPI tennis data that no longer changes in Cloudflare D1, and read it from there. The plan is 10,000 calls/month; about 16,000 are already used. KV on the free tier allows 1,000 writes/day, and the 6h cron (`0 */6 * * *`) already uses about 400 seeding top-50 rank arcs. Plan only: no schema, no deploy, no RapidAPI calls.

**A FINAL** — write once, keep. **B SLOW** — scheduled refresh. **C LIVE** — edge cache and the feed. Auth, sessions, favorites, and brackets stay in KV.

## D1 free tier (checked 2026-09-28)

Workers Free, from [pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [limits](https://developers.cloudflare.com/d1/platform/limits/) (pages updated 2026-04-21): **5 million rows read/day**, **100,000 rows written/day**, **5 GB storage** across all databases on the account, **500 MB per database**. Caps reset 00:00 UTC. Since [2026-09-01](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/) a query over the daily cap fails until reset. Rows read count rows scanned, and each index update bills an extra row written. The first build is a few hundred thousand `match_players` rows and, including those index writes, takes about **3 to 5 days** at the 100,000 rows-written/day cap. A free Worker may run **50 queries per invocation**. A [binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/) (updated 2026-09-11) needs **no API token** in the Worker: `env.TENNIS_DB` is the permission. Wrangler on Nico’s Mac uses his existing login; that credential is not a Worker secret.

## Inventory

Every `rapidFetch` path in `src/apiClient.js`, plus Sackmann imports and api-tennis.com leftovers. “edge+KV” is `cache.set` (edge, TTL, and a `:stale` put). “edge” is `cache.setEdge`.

| Kind | Upstream | Read today | Cache today | Group | After |
|---|---|---|---|---|---|
| Finished matches | `GET /{tour}/tournament/results/{id}` | Draws `/api/draws`. Scores re-reads today in `/api/hub`, `/api/livescore` | Draws edge+KV 24h once the final is done, else 5min / 10min / 1h. Hub 5min edge. Livescore 30s, or 2min when idle | A finished. C live slice | `matches` + `match_players` |
| Past-season player matches | `GET /{tour}/player/past-matches/{id}` | Player `/api/player-history` (500). Rankings, Player, panel `/api/player-stats` (200). Analytics, Player, panel `/api/h2h` (200, after the Sackmann cutoff). Curves `/api/player-vintage` (paged) | edge+KV 12h / 6h / 48h / 24h | A | `matches` + `match_players`. First build learns `first_api_season`; later jobs stop there |
| Current-season match tail | same | same four | a miss re-downloads the whole window | B | scheduled append |
| Draw fixtures + info | `GET /{tour}/fixtures/tournament/{id}`, `GET /{tour}/tournament/info/{id}` | Draws. Hub + livescore use fixtures for today’s board | draws TTL above; hub/livescore edge | A when finished; B in progress; C today’s board | `matches`, `tournaments` |
| Official first-round order | admin import of tour sheets, not RapidAPI | Draws, inside `/api/draws` | KV `tw:official-draw:v1:*`, no TTL | A | not in this layout; stays KV |
| Calendar | `GET /{tour}/tournament/calendar/{year}` (≤8 pages, ~5 used) | Draws `/api/calendar`; cron; hub + livescore (current year, uncached); 5-year map for h2h / history / stats; vintage tier map. Scripts `backfill-tier-map.ts`, `upcomingDraws.mjs`, `testDraws.mjs` | route 2h; map 24h; past year 30d. edge+KV | A past years; B this year | `tournaments` |
| Current weekly rankings | `GET /{tour}/ranking/singles` | Rankings `/api/standings`; Curves roster; Draws on a miss; cron | edge+KV 48h (`standings2`), then a top-50 rank-arc put | B, dated with the feed’s ranking date | `rankings` |
| Historical rankings | Sackmann via `/api/admin/import-rankings-history`. `filter=RankingDate:` only from `/api/admin/backfill-rankings` | Time Machine `/api/rankings-history`; Player `/api/player-ranking-history`; Curves `/api/vintage-rank-by-age` | KV, no TTL. A profile GET also puts today’s rank | A for closed weeks. Today’s put is B, and not on a public read | `rankings` |
| Birthday, static profile | `GET /{tour}/player/profile/{id}` | `/api/players` (Player, panel); birthday on `/api/player-stats`; Curves vintage | edge+KV 72h / 30d / 24h | A. Current rank is B | `players` |
| Titles | `GET /{tour}/player/titles/{id}` | `/api/player-stats`; folded into `/api/player-history` | count 72h; history payload 12h | A through last season; B this season | `player_totals` / `player_stats_blob` |
| H2H summary | `GET /{tour}/h2h/info/{a}/{b}` | Hub featured pair only. `/api/h2h` sums the match log + past matches | inside the hub 5min payload | derived | current H2H store for v1 |
| Sackmann match log | CSVs → `/api/admin/import-matches`, `tw:matches:v1:*` | `/api/h2h` | KV, no TTL, cap 4000 | A | `matches` + `match_players`, zero API |
| Sackmann curves | vintage, career rank arcs, rank-by-age imports | Curves; Player rank chart | KV no TTL; rank-by-age also edge 24h | A | `players`, `matches`, `rankings` |
| Live board | `GET /extend/api/events/live` | `/api/livescore`, `/api/hub` | edge 30s or 2min; `:seen` edge 12h; `:done` KV 12h only when the completed set changes; hub 5min | C | RapidAPI + edge. No D1 |
| Per-event live score | `GET /extend/api/event/live-score/get/{id}` | none (`liveScoreByEventId` unused) | none | C | do not store |
| api-tennis.com leftovers | `get_fixtures`, `get_tournaments`, `get_standings`, `get_players`. `get_H2H` has no caller | `/api/fixtures`, `/api/surface-standings` only from unmounted `script.js`. `/api/tournaments` has no page | edge+KV 24h / 48h / 24h. Profiles use another id namespace | out of scope | stay on KV. Do not copy into D1 or replace with RapidAPI |

`/api/predict` (Draws bar, bracket autofill, Analytics) calls standings, player-stats, and h2h, then edge+KV 6h. It follows those routes. The Supabase stub in `src/db.js` is not this plan.

## Table layout (owned by TW Analytics)

```sql
players (
  player_id INTEGER PRIMARY KEY,
  api_id INTEGER UNIQUE,            -- tennis API id, e.g. 47275
  sackmann_id INTEGER UNIQUE,       -- the number in our s-keys
  tour TEXT CHECK (tour IN ('atp','wta')),
  name TEXT, country TEXT, birth_date TEXT,
  first_api_season INTEGER,         -- feeds the Indoor caption
  stats_built_at TEXT )

tournaments (
  tournament_id INTEGER PRIMARY KEY,
  source TEXT, source_id TEXT, season INTEGER, name TEXT,
  surface TEXT CHECK (surface IN ('hard','clay','grass','carpet')),
  indoor INTEGER,                   -- 1/0; NULL for Sackmann (unknown)
  level TEXT,                       -- slam|finals|1000|500_250|challenger|itf|team
  UNIQUE (source, source_id, season) )

matches (
  match_id INTEGER PRIMARY KEY, source TEXT, source_id TEXT,
  tournament_id INTEGER, match_date TEXT, season INTEGER, round TEXT,
  best_of INTEGER, winner_id INTEGER, loser_id INTEGER, score TEXT,
  outcome TEXT CHECK (outcome IN ('completed','retired','walkover')),
  UNIQUE (source, source_id) )

match_players (                     -- 2 rows per match, one per player
  match_id, player_id, opponent_id, PRIMARY KEY (match_id, player_id),
  season, surface, indoor, level,   -- copied from the match for fast grouping
  won, opp_rank, has_stats,
  sv_pts, first_in, first_won, second_won, aces, dfs,
  bp_faced, bp_saved, sv_games, sv_games_est,
  ret_pts, ret_won, bp_chances, bp_converted, ret_games,  -- copied from the opponent's serve
  sets_won, sets_lost, tb_won, tb_lost, lost_first_set, deciding_set )
INDEX match_players (player_id, season)

rankings (tour, rank_date, player_id, rank, PRIMARY KEY (tour, rank_date, player_id))

player_totals (                     -- rebuilt per player by the job
  player_id, season, surface, level, rank_band, source,
  matches, matches_with_stats, wins, losses, <every count above, summed>,
  PRIMARY KEY (player_id, season, surface, level, rank_band) )

player_stats_blob (player_id INTEGER PRIMARY KEY, built_at TEXT, json TEXT)
```

- **Player IDs.** One `player_id` per person, whichever source saw them first. Sackmann and API seasons attach to that same player via `api_id` / `sackmann_id`.
- **`first_api_season`.** The first build fetches older past-matches pages for each player until a page returns no stats, and records the earliest season that had stats as `first_api_season`. After that, no job requests anything older.
- **Stats live on `match_players`.** There is no separate stats table. Each match has two rows, and return counts are copied from the opponent's serve. A match without stats stores NULL in the stat columns, never zeros.
- **Surface.** API `courtId` 3 is stored as `hard` with `indoor=1`. Sackmann carpet stays `carpet`, `indoor` NULL, and counts under the Indoor filter.
- **Two sources, one season.** Both sources may hold the same match (needed for the 20-match cross-source comparison). Totals use Sackmann only for seasons before `first_api_season` and never mix sources within a season.
- **Walkovers and retirements.** Walkovers are stored but excluded from records and stats. Retirements count in W-L; their stats count only if the first set was completed.
- **`opp_rank`.** The job looks it up from `rankings` using the latest official `rank_date` on or before `match_date`. The hit rate is the 90% gate that decides whether the rank-band row ships in v1. Rank bands: `top10`, `11_50`, `51_100`, `101_plus`, `unknown`.
- **Page read.** `player_stats_blob` is one row per player and the only table the public route reads (one indexed row per uncached view). `json` is capped at about 256 KB. `player_totals` and the blob are rebuilt in the same batch. Filtering happens in the browser.
- **Rebuilds.** Idempotent: delete and reinsert each player's rows in one transaction.
- **Size.** The first build is about 400 players, up to 500 matches each: a few hundred thousand `match_players` rows, two per match. Index writes count toward the 100,000 rows-written/day cap, and v1 has no opponent index, so the load is about **3 to 5 days**. That fits step 3 (cached KV + Sackmann, zero RapidAPI calls) before the step 5 API backfill, which waits for the quota reset on about 16 Oct 2026.
- **H2H.** Stays on the current H2H store for v1. No opponent index now: D1 bills every index update as a row written, which would slow the first build. After the D1 data passes the 20-match cross-source comparison, H2H can move to D1 with an index on `match_players (player_id, opponent_id)`. That also removes the ordered-pair caching that caused the Sinner–Alcaraz mismatch.
- **Types and checks** (future migration, not this PR):
  - ID and grouping columns: `INTEGER NOT NULL` or `TEXT NOT NULL`. `won`, `has_stats`, `sv_games_est`, `lost_first_set`, `deciding_set`: `CHECK (x IN (0,1))`. `surface`, `level`, and `rank_band`: fixed lists, the same way `tournaments.surface` does.
  - Stat counts: `INTEGER` NULL allowed, `CHECK (x IS NULL OR x >= 0)`. A match without stats stores NULL, never 0, plus `CHECK (has_stats = 1 OR sv_pts IS NULL)`.
  - Cross-column checks: `first_won <= first_in <= sv_pts`, `bp_saved <= bp_faced`, `bp_converted <= bp_chances`, `ret_won <= ret_pts`. A violating import row fails its whole batch.
  - `opp_rank`: `INTEGER` NULL allowed. NULL means rank unknown (distinct from unranked). `rank_band` records which.
  - `player_totals` counts: `INTEGER NOT NULL DEFAULT 0`. Stat sums include only matches with stats. `matches_with_stats` is the denominator for every percentage.

## Read and write rules

- Only the scheduled job and admin-secret imports write, through one write module. Public routes use a read-only module. A test fails if a public route imports the write module. A visitor cache miss never writes D1.
- Every query is `prepare().bind()`. Identifiers come from fixed lists.
- Public reads validate input, fail closed on rate limits, keep the edge cache, and use an index plus `LIMIT`.
- Imports have a row cap, per-row validation, and one transaction per batch (under 50 queries per invocation).
- Feed text is stored as plain text and rendered only with `textContent`.
- `player_stats_blob` is written only by the job. The public route returns it as-is. The page renders every name and label inside it with `textContent` or `createElement` only.
- Cap `player_stats_blob.json` at a fixed size (about 256 KB). The job refuses to write a larger blob: it logs and skips that player, so a bad build cannot serve something huge.
- No account data in D1.
- Schema changes are reviewed migration files. A destructive change needs Nico’s go and a restore point (Time Travel is 7 days on Free).
- Worker binding only. No API token in the Worker or in `wrangler.toml`.

## Rollout

0. **In flight:** PR #17 (stop player-stats and player-history burning KV on bad keys), the quota PR with the hard stop, and the UI polling PR.
1. **Nico creates the database once, from his Mac.** Not from CI or an agent. Decline the prompt that edits `wrangler.toml`.

   ```bash
   npx wrangler d1 create tennisworld
   ```

   ```toml
   [[d1_databases]]
   binding = "TENNIS_DB"
   database_name = "tennisworld"
   database_id = "<id printed by create>"
   ```

2. Schema migration PR. Empty tables. The binding snippet lands here.
3. Load data we already have, at zero API cost: KV `tw:matches:v1:*`, Sackmann CSVs, cached rankings and vintage.
4. Switch reads route by route. Edge cache stays in front. A miss reads D1 and does not write.
5. API backfill of FINAL rows only after the quota reset (about 16 Oct 2026), under a daily call budget.
6. First D1 feature: `player_totals` and `player_stats_blob` (season, surface, level, rank band). The page reads the blob.

## Estimated savings

From the code, not from traffic. Miss counts are unmeasured and are not guessed.

| Group | RapidAPI | KV writes |
|---|---|---|
| A | Repeat calls for a stored row go to zero after the one-time load. Daily volume is miss traffic, not estimated. | TTL refreshes stop (`cache.set` is two puts). Not estimated. |
| B | Per refresh, from current caps: rankings ≤10 pages × 2 tours; current-year calendar ≤8 pages × 2 tours. Titles: 1 call per player refreshed. In-progress draw: 3 calls. Player and event counts not estimated. | Rank-arc seeding is 50 × 2 tours × 4 runs ≈ **400 puts/day** (the cron’s current spend). One snapshot per official date replaces it. Profile-view puts of today’s rank also stop; that extra is traffic, not estimated. |
| C | No cut to `events/live`. Hub and livescore can skip calendar and finished results once those are in D1; that cut is the miss rate, not estimated. | Payloads stay edge-only. `:done` still writes when the completed set changes. |

## Open questions

1. Is the reset still about 16 Oct 2026, and what daily call cap should step 5 use?
2. Sackmann is ATP-only. WTA FINAL after the reset, or ATP first?
3. Retire the api-tennis leftovers, or leave them on KV?
4. In-progress draws on the 6h cron, or sooner? Livescore stays 30s either way.
5. Is Time Travel (7 days) enough as the restore point, or also a SQL export?
