import { cache } from '../cache.js';

// GET /api/player-ranking-history?tour=ATP|WTA&playerKey=47275
//
// Returns { history: [{date, rank}] } sorted oldest→newest for a line chart.
//
// Storage: permanent KV entries (no TTL) accumulate one snapshot per ranking
// date. Snapshots are written:
//   - here, lazily, on each profile view
//   - by the cron job for top-N players to seed history before anyone visits
//
// KV key: tw:rank-history:v1:{tour}:{playerKey}
//   The key is per player, not per day. The official ranking date lives on
//   each value entry.
// Value : [{date: "YYYY-MM-DD", rank: N}, ...]  full career (weekly from the
//         Sackmann backfill + live snapshots), capped generously so a
//         decades-long career is never truncated (2600 ≈ 50 years of weekly data).
// `date` is the feed's ranking date (standings `rankingDate`, or the rankings
// row `date`). It is never the day the cron or the profile request ran.

export const KV_MAX_ENTRIES = 2600;

function todayISO() {
    return new Date().toISOString().split('T')[0];
}

// Feed ranking dates are YYYY-MM-DD, sometimes with a time suffix. Anything
// else is missing — callers must not substitute the run date.
export function officialRankingDate(raw) {
    if (raw == null) return null;
    const day = String(raw).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

// Histories are oldest→newest, so the latest entry is the current ranking
// week. A date already stored anywhere is also a hit, so a re-run does not
// rewrite the whole array.
function snapshotDateExists(history, date) {
    if (!history?.length) return false;
    if (history[history.length - 1]?.date === date) return true;
    return history.some(e => e?.date === date);
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
// `rankingDate` (or raw rankings `date`) is the official feed date. A missing
// date is skipped. A date already stored is skipped, so the daily job does
// not rewrite the same ranking week.
export async function seedRankSnapshots(env, tour, players) {
    await Promise.allSettled(
        players.map(async p => {
            if (!p?.playerKey || !p.rank) return;
            const date = officialRankingDate(p.rankingDate ?? p.date);
            if (!date) return;
            const history = await readHistory(env, tour, p.playerKey);
            if (snapshotDateExists(history, date)) return;
            const updated = appendSnapshot(history, p.rank, date);
            await writeHistory(env, tour, p.playerKey, updated);
        })
    );
}

export async function handlePlayerRankHistory(request, env) {
    const { searchParams } = new URL(request.url);
    const tour      = (searchParams.get('tour') || 'ATP').toUpperCase();
    const playerKey = (searchParams.get('playerKey') || '').trim();
    if (!playerKey) throw new Error('playerKey is required');

    // Read stored history
    let history = await readHistory(env, tour, playerKey);

    // Append the current rank under the feed's ranking date. No date on the
    // cached standings row means skip — do not stamp the request's run date.
    const standingsCached = await cache.get(env, 'standings2', tour);
    if (standingsCached) {
        const player = (standingsCached.data || []).find(p => p.playerKey === playerKey);
        const date = officialRankingDate(player?.rankingDate ?? player?.date);
        if (player?.rank && date && !snapshotDateExists(history, date)) {
            history = appendSnapshot(history, player.rank, date);
            // Fire-and-forget write — don't block the response
            writeHistory(env, tour, playerKey, history).catch(() => {});
        }
    }

    return { history };
}
