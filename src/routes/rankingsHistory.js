// ===================================
// TennisWorld — Historical Rankings (date-keyed, back to 1973)
// ===================================
// The player-centric rank history (playerRankHistory.js) answers "what was THIS
// player's rank over time." This module answers the inverse: "what were the
// rankings ON a given date" — the full weekly ranking list for any Monday since
// the ATP ranking began (1973-08-27), retired players included.
//
// Storage (KV, per YEAR to stay well under the free-tier write ceiling):
//   tw:rankings-history:v1:{tour}:{year}  → { "YYYY-MM-DD": [ {rank,name,country,points,pid}, … topN ], … }
//   tw:rankings-history-index:v1:{tour}   → { min, max, dates:[ "YYYY-MM-DD", … ] }  (all weekly dates, ascending)
//
// 2333 weekly ATP dates (1973→2026) as ~54 year-values + 1 index = ~55 writes
// total for a full backfill, vs 2333 if stored per-date. Reads load one year
// value (server-side, cached) and return the requested week.

const yearKey  = (tour, year) => `tw:rankings-history:v1:${tour}:${year}`;
const indexKey = (tour)       => `tw:rankings-history-index:v1:${tour}`;
const YEAR_TTL = 30 * 24 * 60 * 60; // 30d — historical data is effectively static

// ── GET /api/rankings-history ──────────────────────────────────────────────────
//   ?tour=ATP&meta=1                     → { min, max, count, dates:[…] }
//   ?tour=ATP&date=YYYY-MM-DD&limit=100  → { date, requestedDate, tour, prevDate,
//                                            nextDate, count, rankings:[…] }
// The returned `date` is the weekly snapshot ON or BEFORE the requested date.
export async function handleRankingsHistory(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    const index = await env.TENNIS_CACHE.get(indexKey(tour), 'json');
    if (!index || !index.dates || !index.dates.length) {
        throw Object.assign(new Error(`No historical rankings loaded for ${tour}`), { status: 404 });
    }

    if (searchParams.get('meta')) {
        return { tour, min: index.min, max: index.max, count: index.dates.length, dates: index.dates };
    }

    const requested = searchParams.get('date') || index.max;
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '100', 10)));

    // Snap to the weekly snapshot on/before the requested date.
    const dates = index.dates; // ascending
    let idx = -1;
    for (let i = dates.length - 1; i >= 0; i--) {
        if (dates[i] <= requested) { idx = i; break; }
    }
    if (idx < 0) idx = 0; // requested date precedes the first snapshot → use earliest
    const snapDate = dates[idx];
    const prevDate = idx > 0 ? dates[idx - 1] : null;
    const nextDate = idx < dates.length - 1 ? dates[idx + 1] : null;

    const year = snapDate.slice(0, 4);
    const yearData = await env.TENNIS_CACHE.get(yearKey(tour, year), 'json');
    const list = (yearData && yearData[snapDate]) || [];

    return {
        tour,
        requestedDate: requested,
        date: snapDate,
        prevDate,
        nextDate,
        count: list.length,
        rankings: list.slice(0, limit),
    };
}

// ── POST /api/admin/import-rankings-history ─────────────────────────────────────
// Body: { tour, year, snapshots: { "YYYY-MM-DD": [ {rank,name,country,points,pid} … ] } }
// Stores one year's weekly snapshots and merges the year's dates into the index.
// Auth: x-admin-secret header. Idempotent (re-import overwrites the year + merges dates).
export async function handleImportRankingsHistory(request, env) {
    const secret = request.headers.get('x-admin-secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }

    const { tour, year, snapshots } = await request.json();
    if (!tour || !year || !snapshots || typeof snapshots !== 'object') {
        throw new Error('tour, year, and snapshots are required');
    }
    const t = String(tour).toUpperCase();

    await env.TENNIS_CACHE.put(yearKey(t, year), JSON.stringify(snapshots), { expirationTtl: YEAR_TTL });

    // Merge this year's dates into the global index (dedup + sort).
    const index = (await env.TENNIS_CACHE.get(indexKey(t), 'json')) || { dates: [] };
    const set = new Set(index.dates);
    for (const d of Object.keys(snapshots)) set.add(d);
    const dates = Array.from(set).sort();
    await env.TENNIS_CACHE.put(indexKey(t), JSON.stringify({
        min: dates[0], max: dates[dates.length - 1], dates,
    }));

    return { ok: true, year, weeks: Object.keys(snapshots).length, totalDates: dates.length };
}
