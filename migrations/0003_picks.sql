-- Picks. One row per (member_id, match_key). Nico applies this; the Worker
-- does not migrate itself.
--   npx wrangler d1 migrations apply tennisworld --remote
--
-- Timestamps are unix milliseconds set by the server.
-- result is pending | correct | wrong | void.
-- void_reason is '' or walkover | cancelled | player_changed. It is the only
-- void detail a response may show (as voidReason). Never select rank_gap,
-- member_id, or an email into a response.
-- lock_at is the server-computed lock instant. The upsert refuses a change
-- in the same statement when locked_at is set or now is past lock_at.
-- scoreless_seen counts scoreless observations. A walkover voids only when
-- a later refresh is still scoreless. player1_key / player2_key freeze the
-- pairing at lock so an alternate swap can void every pick.

CREATE TABLE IF NOT EXISTS picks (
    member_id TEXT NOT NULL,
    match_key TEXT NOT NULL,
    picked_player_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    locked_at INTEGER,
    lock_at INTEGER NOT NULL,
    result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'correct', 'wrong', 'void')),
    rank_gap INTEGER,
    player1_key TEXT NOT NULL DEFAULT '',
    player2_key TEXT NOT NULL DEFAULT '',
    scoreless_seen INTEGER NOT NULL DEFAULT 0,
    void_reason TEXT NOT NULL DEFAULT '' CHECK (void_reason IN ('', 'walkover', 'cancelled', 'player_changed')),
    tour TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (member_id, match_key)
);

CREATE INDEX IF NOT EXISTS picks_by_match ON picks (match_key);
