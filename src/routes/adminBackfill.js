import { rapidAPI }                              from '../apiClient.js';
import { readHistory, writeHistory, appendSnapshot, KV_MAX_ENTRIES } from './playerRankHistory.js';
import { readMatchLog, writeMatchLog, mergeMatches } from './playerMatches.js';

// GET /api/admin/backfill-rankings?tour=ATP|WTA&weeksBack=26&secret=XXX
//
// One-time (or occasional) operation that populates KV ranking history from the
// RapidAPI historical snapshots endpoint.
//
// Strategy:
//   1. Generate weekly Monday dates going back `weeksBack` weeks (oldest → newest)
//   2. Fetch each date's snapshot sequentially (150 ms gap to avoid rate limits)
//   3. Collect all snapshots in memory, keyed by playerKey
//   4. One KV read + write per player (not per week)
//
// Cloudflare Workers have a 30 s wall-clock budget. At ~600 ms per API call
// (network + 150 ms delay), 26 weeks ≈ 16 s. Cap weeksBack at 26 per call.
// For a full year run it twice with `offset`:
//   ?weeksBack=26&offset=0   (most recent 26 weeks)
//   ?weeksBack=26&offset=26  (weeks 27–52)

const MAX_WEEKS  = 26;
const CALL_DELAY = 150; // ms between upstream API calls

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Generate ISO date strings for the Monday of each week, newest first.
// offset skips the most recent N weeks (for pagination).
function weeklyDates(weeksBack, offset = 0) {
    const dates = [];
    const today = new Date();
    // Snap backwards to the most recent Monday
    const dow   = today.getDay(); // 0=Sun
    const toMon = dow === 0 ? 6 : dow - 1;
    const base  = new Date(today);
    base.setDate(today.getDate() - toMon);
    base.setHours(0, 0, 0, 0);

    for (let i = offset; i < offset + weeksBack; i++) {
        const d = new Date(base);
        d.setDate(base.getDate() - i * 7);
        dates.push(d.toISOString().split('T')[0]);
    }
    // Return oldest → newest so history builds forward
    return dates.reverse();
}

// GET /api/admin/clear-rank-history?tour=ATP|WTA&secret=XXX
// Deletes all rank-history KV entries for a tour by scanning known player IDs
// from the current standings. Use after a bad backfill run.
export async function handleClearRankHistory(request, env) {
    const { searchParams } = new URL(request.url);
    const secret = searchParams.get('secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        const err = new Error('Unauthorized'); err.status = 401; throw err;
    }

    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    // Pull current standings to get the player IDs we wrote history for
    const res     = await rapidAPI.rankings(env, tour, 500);
    const players = (res?.data || []).map(r => String(r.player?.id)).filter(Boolean);

    let deleted = 0;
    for (const playerKey of players) {
        const key = `tw:rank-history:v1:${tour}:${playerKey}`;
        await env.TENNIS_CACHE.delete(key);
        deleted++;
    }

    return { ok: true, tour, deleted };
}

// POST /api/admin/import-rank-history
// Accepts pre-processed history from the local backfill-sackmann.ts script.
// Body: { tour: "ATP"|"WTA", histories: { [playerKey]: [{date, rank}] } }
// Auth: x-admin-secret header.
export async function handleImportRankHistory(request, env) {
    const secret = request.headers.get('x-admin-secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        const err = new Error('Unauthorized'); err.status = 401; throw err;
    }

    const { tour, histories } = await request.json();
    if (!tour || !histories) throw new Error('tour and histories are required');

    let written = 0, errors = 0;
    for (const [playerKey, snapshots] of Object.entries(histories)) {
        try {
            // Merge incoming snapshots with any existing history in ONE pass
            // (dedup by date, keep the best rank), then sort + cap once — far
            // cheaper than appendSnapshot per entry for career-length series.
            const existing = await readHistory(env, tour, playerKey);
            const byDate = new Map(existing.map(e => [e.date, e.rank]));
            for (const { date, rank } of snapshots) {
                if (!date || !(rank > 0)) continue;
                if (!byDate.has(date) || rank < byDate.get(date)) byDate.set(date, rank);
            }
            const merged = Array.from(byDate, ([date, rank]) => ({ date, rank }))
                .sort((a, b) => a.date.localeCompare(b.date))
                .slice(-KV_MAX_ENTRIES);
            await writeHistory(env, tour, playerKey, merged);
            written++;
        } catch (e) {
            errors++;
        }
    }

    return { ok: true, written, errors };
}

// POST /api/admin/import-matches
// Accepts pre-processed per-player career match logs from the local
// backfill-h2h-matches.ts script (seeded from Jeff Sackmann's archive) so /api/h2h
// can surface complete history including retired opponents.
// Body: { tour: "ATP"|"WTA", logs: { [playerKey]: [MatchRec] } }
// Auth: x-admin-secret header.
export async function handleImportMatches(request, env) {
    const secret = request.headers.get('x-admin-secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        const err = new Error('Unauthorized'); err.status = 401; throw err;
    }

    const { tour, logs } = await request.json();
    if (!tour || !logs) throw new Error('tour and logs are required');

    let written = 0, errors = 0;
    for (const [playerKey, matches] of Object.entries(logs)) {
        try {
            const existing = await readMatchLog(env, tour, playerKey);
            const merged   = mergeMatches(existing, matches);
            await writeMatchLog(env, tour, playerKey, merged);
            written++;
        } catch (e) {
            errors++;
        }
    }

    return { ok: true, written, errors };
}

export async function handleBackfillRankings(request, env) {
    const { searchParams } = new URL(request.url);

    // ── Auth ──────────────────────────────────────────────────────────────────
    const secret = searchParams.get('secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        const err = new Error('Unauthorized'); err.status = 401; throw err;
    }

    const tour      = (searchParams.get('tour') || 'ATP').toUpperCase();
    const weeksBack = Math.min(Number(searchParams.get('weeksBack') || 26), MAX_WEEKS);
    const offset    = Math.max(Number(searchParams.get('offset')   || 0),  0);
    const dryRun    = searchParams.get('dryRun') === 'true';

    const dates = weeklyDates(weeksBack, offset);
    const log   = [];

    // ── Step 1: collect all historical snapshots ───────────────────────────────
    // snapshots[playerKey] = [{date, rank}, ...]
    const snapshots = {};

    for (const date of dates) {
        try {
            const res  = await rapidAPI.rankingsAtDate(env, tour, date, 200);
            const rows = res?.data || [];

            if (date === dates[0]) {
                // Log first response shape so we can verify the filter format works
                const sample = rows[0];
                log.push(`[shape-check] first row keys: ${sample ? Object.keys(sample).join(',') : 'none'}`);
                log.push(`[shape-check] player keys: ${sample?.player ? Object.keys(sample.player).join(',') : 'n/a'}`);
            }

            let count = 0;
            for (const r of rows) {
                if (!r.player?.id || !r.position) continue;
                const key = String(r.player.id);
                if (!snapshots[key]) snapshots[key] = [];
                snapshots[key].push({ date, rank: Number(r.position) });
                count++;
            }
            log.push(`${date}: ${count} players`);
        } catch (e) {
            log.push(`${date}: ERROR — ${e.message}`);
        }
        await sleep(CALL_DELAY);
    }

    const playerKeys = Object.keys(snapshots);

    if (dryRun) {
        return {
            dryRun:  true,
            tour,
            dates:   dates.length,
            offset,
            players: playerKeys.length,
            log,
        };
    }

    // ── Step 2: merge into KV (one read + write per player) ──────────────────
    let written = 0;
    let errors  = 0;

    for (const playerKey of playerKeys) {
        try {
            let history = await readHistory(env, tour, playerKey);
            for (const snap of snapshots[playerKey]) {
                history = appendSnapshot(history, snap.rank, snap.date);
            }
            await writeHistory(env, tour, playerKey, history);
            written++;
        } catch (e) {
            errors++;
            log.push(`kv-err:${playerKey} — ${e.message}`);
        }
    }

    return {
        ok:      true,
        tour,
        dates:   dates.length,
        offset,
        players: playerKeys.length,
        written,
        errors,
        log,
    };
}
