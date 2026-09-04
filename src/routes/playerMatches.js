// ===================================
// Player Match Log — Sackmann-backed career match history in KV
// ===================================
// A per-player full-career match log, seeded from Jeff Sackmann's atp_matches_*.csv
// (via scripts/backfill-h2h-matches.ts → /api/admin/import-matches) and read by the
// H2H route so head-to-heads include the COMPLETE history — including retired
// opponents that the live RapidAPI "last 200 matches" window can never surface.
//
// KV key: tw:matches:v1:{tour}:{playerKey}
// Value : [{ matchKey, date, tournamentName, surface, round,
//            opponentKey, opponentName, won, score }]  — oldest→newest.
//   · `score` is Sackmann's raw winner-first string ("6-4 3-6 7-6(5)").
//   · `won` is from THIS player's perspective; orientation to player1/player2
//     happens at read time in the H2H route.
//
// playerKey convention: active players use their RapidAPI key (name-matched to the
// standings roster); retired players use 's'+SackmannId — identical to the vintage
// legends scheme (src/routes/vintage.js), so both datasets share one namespace.

export const MATCHLOG_MAX = 4000; // longer than any real career (Connors ≈ 1500)

const logKey = (tour, playerKey) => `tw:matches:v1:${tour}:${playerKey}`;

export async function readMatchLog(env, tour, playerKey) {
    const raw = await env.TENNIS_CACHE.get(logKey(tour, playerKey), { type: 'json' });
    return Array.isArray(raw) ? raw : [];
}

export async function writeMatchLog(env, tour, playerKey, matches) {
    const sorted = [...matches].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    await env.TENNIS_CACHE.put(logKey(tour, playerKey), JSON.stringify(sorted.slice(-MATCHLOG_MAX)));
}

// Merge incoming match entries into an existing log, deduped by stable matchKey.
// Incoming wins on collision so re-runs update in place rather than duplicate.
export function mergeMatches(existing, incoming) {
    const byKey = new Map((existing || []).map(m => [m.matchKey, m]));
    for (const m of (incoming || [])) {
        if (m && m.matchKey) byKey.set(m.matchKey, m);
    }
    return Array.from(byKey.values());
}
