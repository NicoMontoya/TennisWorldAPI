// GET  /api/vintage-rank-by-age?tour=ATP|WTA&playerKey=s103819
// POST /api/admin/import-vintage-rank-by-age
//
// One ATP rank per age year for Vintage Curves. The UI passes the same
// playerKey it uses for /api/player-vintage (RapidAPI id, or s + Sackmann id
// for a retired legend).
//
// Response (ATP, loaded) — birth dates are never included:
// {
//   tour: "ATP",
//   playerKey: "s103819",
//   name: "Roger Federer",
//   asOf: "2026-06-08",             // last ranking date in storage, not today
//   rankingsStart: "1973-08-27",    // first ranking date in storage
//   ageAtRankingsStart: null,       // age on rankingsStart, or null if unborn then.
//                                   // UI: pre-1973 note only if a visible age is
//                                   // below this number.
//   available: true,
//   years: [
//     { age: 22, rank: 1, weeksAtRank: 26.9, rankedWeeks: 52.3, partial: false }
//   ]
// }
//
// years is sparse. Omit a missing age (gap — do not draw 0, do not span the
// gap). weeksAtRank / rankedWeeks are days/7 rounded to 1 decimal; tooltip copy
// rounds those to whole numbers ("held 27 of 52 ranked weeks"). partial is true
// only for the age year that contains asOf. Tooltip suffix for that point:
// " · through {asOf formatted, e.g. Jun 8, 2026}".
//
// Other reasons (years is []):
//   wta-ranking-history-not-loaded  available false. WTA history is not loaded.
//   rankings-not-loaded             available false. ATP weekly index is missing.
//   not-loaded                      available false. Index exists; this player
//                                   has no precomputed record yet.
//   no-ranking-history              available true. No age year with >= 13 ranked weeks.
//   no-birthday                     available true. Age cannot be computed.
// `reason` is omitted when years is non-empty.
//
// Cost:
//   GET warm (Cache API hit, including a cached miss): 0 KV reads, 0 KV writes.
//   GET cold hit: 1 KV read (this player's record), 0 writes, then an edge store (24h).
//   GET miss: that read + 1 index read, 0 writes, then an edge store of the
//   not-loaded / rankings-not-loaded body (1h). Import deletes that edge entry.
//   Backfill: 1 permanent KV write per roster player (script dry-run unless
//   --write). No per-request writes. See docs/sackmann-atp-backfill.md.
//
// playerKey is s + 1–10 digits, or 1–10 digits. Anything longer is 400 and
// does not touch KV. GET is rate-limited per IP (Cache API bucket
// vintage-rank-by-age, same helper as /api/hub and /api/livescore).
//
// Storage: tw:vintage-rank-by-age:v1:{tour}:{playerKey}
//   { name, asOf, rankingsStart, ageAtRankingsStart, years, reason? }
// Edge key is separate (tw:vintage-rank-by-age-v1:…) so cache.get cannot
// mistake the permanent record for an edge wrapper.

import { cache } from '../cache.js';
import { parseTour, rateLimit } from '../security.js';
import { indexKey } from './rankingsHistory.js';
import { canonicalPlayerKey, MIN_RANKED_WEEKS } from '../rankByAge.js';

const TTL_EDGE = 24 * 60 * 60;
const TTL_MISS = 60 * 60;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IMPORT = 40;

export const rankByAgeKey = (tour, playerKey) => `tw:vintage-rank-by-age:v1:${tour}:${playerKey}`;

function edgeParts(tour, playerKey) {
    return ['vintage-rank-by-age-v1', tour, playerKey];
}

function httpError(status, message) {
    throw Object.assign(new Error(message), { status });
}

function isoOrNull(value) {
    if (typeof value !== 'string' || !ISO_RE.test(value)) return null;
    return value;
}

function ageOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 120) return null;
    return n;
}

function round1(n) {
    return Math.round(Number(n) * 10) / 10;
}

function sanitizeYears(raw) {
    if (!Array.isArray(raw)) return [];
    const byAge = new Map();
    for (const y of raw) {
        const age = Number(y?.age);
        const rank = Number(y?.rank);
        const weeksAtRank = round1(y?.weeksAtRank);
        const rankedWeeks = round1(y?.rankedWeeks);
        if (!Number.isInteger(age) || age < 0 || age > 80) continue;
        if (!Number.isInteger(rank) || rank < 1 || rank > 200) continue;
        if (!Number.isFinite(weeksAtRank) || !Number.isFinite(rankedWeeks)) continue;
        if (rankedWeeks < MIN_RANKED_WEEKS) continue;
        const point = {
            age,
            rank,
            weeksAtRank,
            rankedWeeks,
            partial: y?.partial === true,
        };
        const prev = byAge.get(age);
        if (!prev || point.rankedWeeks > prev.rankedWeeks || (point.rankedWeeks === prev.rankedWeeks && point.rank < prev.rank)) {
            byAge.set(age, point);
        }
    }
    return [...byAge.values()].sort((a, b) => a.age - b.age);
}

// Drops birthday / dob / anything else on the admin payload.
export function sanitizeRankByAgeRecord(raw) {
    const years = sanitizeYears(raw?.years);
    const reason = raw?.reason === 'no-birthday' ? 'no-birthday' : 'no-ranking-history';
    const rec = {
        name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : null,
        asOf: isoOrNull(raw?.asOf),
        rankingsStart: isoOrNull(raw?.rankingsStart),
        ageAtRankingsStart: ageOrNull(raw?.ageAtRankingsStart),
        years,
    };
    if (!years.length) rec.reason = reason;
    return rec;
}

function toPublic(tour, playerKey, record) {
    const stored = sanitizeRankByAgeRecord(record);
    const body = {
        tour,
        playerKey,
        name: stored.name,
        asOf: stored.asOf,
        rankingsStart: stored.rankingsStart,
        ageAtRankingsStart: stored.ageAtRankingsStart,
        available: true,
        years: stored.years,
    };
    if (!stored.years.length) body.reason = stored.reason;
    return body;
}

function unavailable(tour, playerKey, reason, extra = {}) {
    return {
        tour,
        playerKey,
        name: null,
        asOf: extra.asOf ?? null,
        rankingsStart: extra.rankingsStart ?? null,
        ageAtRankingsStart: null,
        available: false,
        reason,
        years: [],
    };
}

export async function handleVintageRankByAge(request, env) {
    await rateLimit(env, request, 'vintage-rank-by-age');

    const { searchParams } = new URL(request.url);
    const tour = parseTour(searchParams.get('tour'));
    const rawKey = searchParams.get('playerKey');
    if (rawKey == null || String(rawKey).trim() === '') httpError(400, 'playerKey is required');
    const playerKey = canonicalPlayerKey(rawKey);
    if (!playerKey) httpError(400, 'Invalid playerKey.');

    // WTA weekly history is not in KV. Do not scan or 404.
    if (tour === 'WTA') return unavailable(tour, playerKey, 'wta-ranking-history-not-loaded');

    const edge = await cache.getEdge(...edgeParts(tour, playerKey));
    if (edge?.data?.tour === tour && edge.data.playerKey === playerKey) return edge.data;

    const stored = await env.TENNIS_CACHE.get(rankByAgeKey(tour, playerKey), 'json');
    if (stored && typeof stored === 'object') {
        const body = toPublic(tour, playerKey, stored);
        await cache.setEdge(TTL_EDGE, body, ...edgeParts(tour, playerKey));
        return body;
    }

    // Player record missing. One extra read so the UI still learns the calendar
    // horizon. The miss itself is edge-cached so random valid keys cannot
    // re-read KV on every poll. Import deletes this edge entry.
    const index = await env.TENNIS_CACHE.get(indexKey(tour), 'json');
    const miss = (!index?.dates?.length)
        ? unavailable(tour, playerKey, 'rankings-not-loaded')
        : unavailable(tour, playerKey, 'not-loaded', {
            asOf: index.max || null,
            rankingsStart: index.min || null,
        });
    await cache.setEdge(TTL_MISS, miss, ...edgeParts(tour, playerKey));
    return miss;
}

// POST /api/admin/import-vintage-rank-by-age
// Body: { tour: "ATP", records: { [playerKey]: { name, asOf, rankingsStart, ageAtRankingsStart, years } } }
// Auth: x-admin-secret. One permanent KV put per player (no TTL). Idempotent.
// WTA is rejected so a mistaken run cannot spend the daily write budget.
export async function handleImportVintageRankByAge(request, env) {
    const secret = request.headers.get('x-admin-secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        httpError(401, 'Unauthorized');
    }

    const body = await request.json();
    const tour = parseTour(body?.tour);
    if (tour === 'WTA') httpError(400, 'WTA ranking history is not available');
    const records = body?.records;
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
        throw new Error('tour and records are required');
    }
    const entries = Object.entries(records);
    if (entries.length > MAX_IMPORT) {
        httpError(400, `Too many records. Send at most ${MAX_IMPORT} per request.`);
    }

    let written = 0, skipped = 0, errors = 0;
    for (const [rawKey, raw] of entries) {
        const playerKey = canonicalPlayerKey(rawKey);
        if (!playerKey || !raw || typeof raw !== 'object') { skipped++; continue; }
        try {
            const clean = sanitizeRankByAgeRecord(raw);
            await env.TENNIS_CACHE.put(rankByAgeKey(tour, playerKey), JSON.stringify(clean));
            await cache.deleteEdge(...edgeParts(tour, playerKey));
            written++;
        } catch {
            errors++;
        }
    }
    return { ok: true, written, skipped, errors };
}
