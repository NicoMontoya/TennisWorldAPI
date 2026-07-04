import { cache } from '../cache.js';

// GET /api/player-ranking-history?tour=ATP|WTA&playerKey=47275
//
// Returns { history: [{date, rank}] } sorted oldest→newest for a line chart.
//
// Storage: permanent KV entries (no TTL) accumulate one snapshot per day.
// Snapshots are written:
//   - here, lazily, on each profile view
//   - by the cron job for top-N players to seed history before anyone visits
//
// KV key: tw:rank-history:v1:{tour}:{playerKey}
// Value : [{date: "YYYY-MM-DD", rank: N}, ...]  max 104 entries (2 years)

const KV_MAX_ENTRIES = 104;

function todayISO() {
    return new Date().toISOString().split('T')[0];
}

export async function readHistory(env, tour, playerKey) {
    const key = `tw:rank-history:v1:${tour}:${playerKey}`;
    const raw = await env.TENNIS_CACHE.get(key, { type: 'json' });
    return Array.isArray(raw) ? raw : [];
}

export async function writeHistory(env, tour, playerKey, entries) {
    const key = `tw:rank-history:v1:${tour}:${playerKey}`;
    await env.TENNIS_CACHE.put(key, JSON.stringify(entries));
}

// Append a rank snapshot to an existing history array.
// date defaults to today; pass a historical date string for backfill.
// Returns the updated array (sorted ascending, capped at KV_MAX_ENTRIES).
export function appendSnapshot(history, rank, date = todayISO()) {
    const updated = history.filter(e => e.date !== date);
    updated.push({ date, rank });
    updated.sort((a, b) => a.date.localeCompare(b.date));
    return updated.slice(-KV_MAX_ENTRIES);
}

// Seed rank snapshots for a list of players — called from the cron job.
export async function seedRankSnapshots(env, tour, players) {
    await Promise.allSettled(
        players.map(async p => {
            if (!p.playerKey || !p.rank) return;
            const history = await readHistory(env, tour, p.playerKey);
            const updated = appendSnapshot(history, p.rank);
            await writeHistory(env, tour, p.playerKey, updated);
        })
    );
}

export async function handlePlayerRankHistory(request, env) {
    const { searchParams } = new URL(request.url);
    const tour      = (searchParams.get('tour') || 'ATP').toUpperCase();
    const playerKey = searchParams.get('playerKey');
    if (!playerKey) throw new Error('playerKey is required');

    // Read stored history
    let history = await readHistory(env, tour, playerKey);

    // Get current rank from standings cache to append today's snapshot
    const standingsCached = await cache.get(env, 'standings2', tour);
    if (standingsCached) {
        const player = (standingsCached.data || []).find(p => p.playerKey === playerKey);
        if (player?.rank) {
            history = appendSnapshot(history, player.rank);
            // Fire-and-forget write — don't block the response
            writeHistory(env, tour, playerKey, history).catch(() => {});
        }
    }

    return { history };
}
