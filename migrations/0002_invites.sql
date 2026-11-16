-- Invite codes. The plaintext is never stored. hash is SHA-256 of the
-- canonical code. Claim a use with one conditional update:
--   UPDATE invites SET uses = uses + 1
--   WHERE hash = ? AND revoked = 0 AND uses < max_uses
-- Create the account only when that statement changes exactly one row.
--
-- Apply before deploy:
--   npx wrangler d1 migrations apply tennisworld --remote

CREATE TABLE IF NOT EXISTS invites (
    hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
);
