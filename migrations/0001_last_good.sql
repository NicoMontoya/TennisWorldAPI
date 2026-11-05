-- Phase 0 last-good store. Nico applies this; the Worker does not migrate itself.
--   npx wrangler d1 create tennisworld
--   paste database_id into wrangler.toml [[d1_databases]]
--   npx wrangler d1 migrations apply tennisworld --local
--   npx wrangler d1 migrations apply tennisworld --remote
--
-- Natural keys are (tour, …). fetched_at is the Worker clock of the upstream
-- pull that wrote the row (ISO-8601 UTC).
--
-- Picks are intentionally not created here. A later picks table should key
-- (tour, match_key, player_key) and reference fixtures (tour, match_key).

CREATE TABLE IF NOT EXISTS tournaments (
    tour TEXT NOT NULL,
    tournament_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (tour, tournament_key)
);

CREATE TABLE IF NOT EXISTS draws (
    tour TEXT NOT NULL,
    tournament_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (tour, tournament_key)
);

CREATE TABLE IF NOT EXISTS fixtures (
    tour TEXT NOT NULL,
    match_key TEXT NOT NULL,
    tournament_key TEXT NOT NULL DEFAULT '',
    match_date TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (tour, match_key)
);

CREATE INDEX IF NOT EXISTS fixtures_by_tournament
    ON fixtures (tour, tournament_key);

CREATE INDEX IF NOT EXISTS fixtures_by_date
    ON fixtures (tour, match_date);

CREATE TABLE IF NOT EXISTS standings (
    tour TEXT NOT NULL,
    player_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (tour, player_key)
);

-- One counter per UTC day. Row upserts reserve against D1_DAILY_WRITE_BUDGET.
CREATE TABLE IF NOT EXISTS d1_write_ledger (
    day TEXT PRIMARY KEY,
    writes INTEGER NOT NULL
);

-- API-Tennis.com list rows (tournaments). Separate from the RapidAPI calendar
-- rows in `tournaments`, which use a different payload shape.
-- natural_key is tournamentKey. A later picks table does not use this table.
CREATE TABLE IF NOT EXISTS api_tennis_lists (
    resource TEXT NOT NULL,
    tour TEXT NOT NULL,
    natural_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (resource, tour, natural_key)
);
