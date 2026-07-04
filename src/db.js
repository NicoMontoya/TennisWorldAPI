// ===================================
// Database Layer — stub for Phase 2
// ===================================
// This module will connect to Supabase (Postgres) when we add the DB.
// For now every method returns null, meaning "no data in DB" and the
// caller falls through to the live API.
//
// The interface is intentionally identical to what the real implementation
// will expose, so routes and services never need to change — just fill
// in the methods below.
//
// Supabase wiring (Phase 2):
//   import { createClient } from '@supabase/supabase-js'
//   const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
//
// Planned tables:
//   - fixtures         (completed match results — grows over time)
//   - standings        (weekly snapshot, append-only for trends)
//   - players          (profile + season stats, upserted on fetch)
//   - h2h              (per-pair history, upserted on fetch)
//   - custom_stats     (our own computed metrics — momentum score, surface rating, etc.)

export const db = {
    // ── Fixtures ──────────────────────────────────────────────
    async getFixtures(env, { tournamentKey, dateStart, dateStop } = {}) {
        // Phase 2: query fixtures table with date/tournament filters
        return null;
    },

    async upsertFixtures(env, fixtures) {
        // Phase 2: INSERT ... ON CONFLICT DO UPDATE
        return;
    },

    // ── Standings ─────────────────────────────────────────────
    async getStandings(env, eventType) {
        // Phase 2: SELECT latest snapshot for eventType
        return null;
    },

    async upsertStandings(env, eventType, rows) {
        // Phase 2: upsert + store dated snapshot for trend analysis
        return;
    },

    // ── Players ───────────────────────────────────────────────
    async getPlayer(env, playerKey) {
        // Phase 2: SELECT from players where player_key = playerKey
        return null;
    },

    async upsertPlayer(env, player) {
        // Phase 2: upsert player profile + stats
        return;
    },

    // ── H2H ───────────────────────────────────────────────────
    async getH2H(env, playerKeyA, playerKeyB) {
        // Phase 2: SELECT from h2h table
        return null;
    },

    async upsertH2H(env, playerKeyA, playerKeyB, data) {
        // Phase 2: upsert h2h record
        return;
    },

    // ── Custom Stats (our own computed fields) ─────────────────
    async getCustomStats(env, playerKey) {
        // Phase 2: SELECT from custom_stats — momentum score, surface ratings, etc.
        return null;
    },

    async setCustomStats(env, playerKey, stats) {
        // Phase 2: upsert computed stats (run nightly via Cron Trigger)
        return;
    },
};
