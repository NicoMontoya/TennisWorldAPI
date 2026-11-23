import { cache } from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL } from '../config.js';
import { parseTour, parseTournamentKey } from '../security.js';
import {
    applyFixtureOverlay,
    fixtureCompositeKey,
    normalizeFixturesFeed,
    tagWalkoverKind,
    walkoverKindOf,
    withTrustedStart,
} from '../transforms/fixturesFeed.js';
import { dedupeFixtures, fixtureTier, orderFixturesByTier, selectTourTarget } from '../transforms/fixtureTier.js';
import { readAsOf, tagAsOf } from '../asOf.js';
import { DRAWS_CACHE_RESOURCE } from '../officialDraw.js';
import { readFixtures, readTournaments, rememberFixtures } from '../d1Store.js';

// Two upstream calls, same as before. The first is a tournament-specific
// fixtures read only when a live tour event is already in a calendar copy
// younger than CALENDAR_TARGET_MAX_AGE_MS (D1 or the calendar-year cache;
// no calendar fetch). The remaining call is one page of the general feed.
// A stale copy, or no live tour event, keeps both calls on the general feed.
// Never a third page, and both calls still go through rapidFetch
// (claimCallSlot + hard stop).
const MAX_CALLS = 2;
const PAGE_SIZE = 100;
const CALENDAR_KEY = 'calendar-year';
const CALENDAR_TARGET_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function httpError(status, message) {
    throw Object.assign(new Error(message), { status });
}

function parseDay(raw) {
    if (raw == null || String(raw).trim() === '') return undefined;
    const day = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        httpError(400, 'Invalid date. Expected YYYY-MM-DD.');
    }
    return day;
}

function calendarItems(cached) {
    const data = cached?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    return [];
}

function calendarCopyFresh(iso, now) {
    const ms = Date.parse(iso || '');
    if (!Number.isFinite(ms)) return false;
    const age = now.getTime() - ms;
    return age >= -60_000 && age <= CALENDAR_TARGET_MAX_AGE_MS;
}

// Calendar rows already on hand, and only from a copy younger than 48h.
// Does not call RapidAPI. A missing timestamp is not fresh.
async function storedCalendarItems(env, tour, now) {
    const items = [];
    try {
        const saved = await readTournaments(env, tour);
        if (saved?.hadRows && calendarCopyFresh(saved.asOf, now)) items.push(...saved.rows);
    } catch { /* D1 miss is not a reason to fetch */ }

    const year = now.getUTCFullYear();
    for (const y of [year - 1, year, year + 1]) {
        const key = [CALENDAR_KEY, tour, String(y)];
        try {
            const cached = await cache.get(env, ...key);
            if (calendarCopyFresh(cached?.cachedAt, now)) items.push(...calendarItems(cached));
        } catch { /* cache miss */ }
        try {
            const stale = await cache.getStale(env, ...key);
            if (calendarCopyFresh(stale?.cachedAt, now)) items.push(...calendarItems(stale));
        } catch { /* no stale copy */ }
    }
    return items;
}

function rowInRange(row, { dateStart, dateStop }) {
    const date = row?.date || '';
    if (!date) return true;
    if (dateStart && date < dateStart) return false;
    if (dateStop && date > dateStop) return false;
    return true;
}

async function pullFixtures(env, query) {
    const { tour, tournamentKey, dateStart, dateStop } = query;
    if (tournamentKey) {
        const raw = await rapidAPI.tournamentFixtures(env, tour, tournamentKey);
        return orderFixturesByTier(normalizeFixturesFeed(raw, query));
    }

    const parts = [];
    let calls = 0;
    const now = new Date();
    const target = selectTourTarget(await storedCalendarItems(env, tour, now), now, query);
    if (target && calls < MAX_CALLS) {
        calls += 1;
        const raw = await rapidAPI.tournamentFixtures(env, tour, target.id);
        const targeted = normalizeFixturesFeed(raw, {
            tour,
            tournamentKey: target.id,
            tournamentName: target.name,
        }).filter(row => rowInRange(row, query));
        parts.push(...targeted);
    }

    for (let pageNo = 1; calls < MAX_CALLS; pageNo++) {
        calls += 1;
        const json = await rapidAPI.fixturesFeed(env, tour, {
            dateStart, dateStop, pageNo, pageSize: PAGE_SIZE,
        });
        const page = Array.isArray(json?.data) ? json.data : [];
        parts.push(...normalizeFixturesFeed({ data: page }, { tour }));
        if (!page.length || json?.hasNextPage === false || page.length < PAGE_SIZE) break;
    }

    return orderFixturesByTier(dedupeFixtures(parts));
}

// GET /api/fixtures?tour=ATP|WTA&dateStart=YYYY-MM-DD&dateStop=YYYY-MM-DD&tournamentKey=123
// RapidAPI list rows are `{ id, date, roundId, tournament, player1, player2 }`.
// Mapping them with the api-tennis event_key normalizer yields blank keys.
export async function handleFixtures(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = parseTour(searchParams.get('tour'));
    const tournamentKey = parseTournamentKey(searchParams.get('tournamentKey'));
    const dateStart = parseDay(searchParams.get('dateStart'));
    const dateStop = parseDay(searchParams.get('dateStop'));

    // fixtures5: rows carry `tier` and tour events are requested before the
    // general feed, so a fixtures4 entry is the previous order.
    const cacheKey = ['fixtures5', tour, tournamentKey || 'all', dateStart || '', dateStop || ''];
    const query = { tour, tournamentKey, dateStart, dateStop };

    // Repeat views within a minute skip KV. The body is the public merge only.
    const edged = await readMergedEdge(query);
    if (edged) return edged;

    let cached = null;
    try {
        cached = await cache.get(env, ...cacheKey);
    } catch {
        cached = null;
    }
    if (cached && Array.isArray(cached.data)) {
        const live = cached.data.filter(row => row?.matchKey);
        if (live.length) return deliverFixtures(env, query, live);
        // Short-TTL empty. Do not pay for another pull until it expires,
        // and do not hide D1 last-good behind that [].
        if (cached.data.length === 0) return deliverFixtures(env, query, await serveStoredFixtures(env, cacheKey, query));
    }

    try {
        const data = await pullFixtures(env, query);
        const live = data.filter(row => row?.matchKey);
        if (!live.length) {
            // Cache the miss briefly. skipStale keeps a previous no-expiry
            // backup; rememberFixtures must not replace saved rows with [].
            try {
                await cache.set(env, TTL.fixturesEmpty, [], ...cacheKey, { skipStale: true });
            } catch { /* cache is fail-soft */ }
            return deliverFixtures(env, query, await serveStoredFixtures(env, cacheKey, query));
        }
        try { await rememberFixtures(env, tour, live); } catch { /* last-good is best-effort */ }
        // Store the schedule only. Status is overlaid on the way out so a
        // 24h fixtures entry cannot freeze a live score or its statusAsOf.
        try { await cache.set(env, TTL.fixtures, live, ...cacheKey); } catch { /* cache is fail-soft */ }
        return deliverFixtures(env, query, live);
    } catch {
        return deliverFixtures(env, query, await serveStoredFixtures(env, cacheKey, query));
    }
}

async function serveStoredFixtures(env, cacheKey, query) {
    const today = new Date().toISOString().slice(0, 10);
    const saved = await readFixtures(env, {
        ...query,
        upcomingFrom: query.dateStart || query.dateStop || query.tournamentKey ? undefined : today,
    });
    if (saved?.hadRows) return tagAsOf(orderFixturesByTier(saved.rows), saved.asOf);

    try {
        const stale = await cache.getStale(env, ...cacheKey);
        const rows = Array.isArray(stale?.data) ? stale.data.filter(row => row?.matchKey) : [];
        if (rows.length) return tagAsOf(orderFixturesByTier(rows), stale.cachedAt || stale.fetchedAt);
    } catch { /* KV miss is an empty board */ }

    return [];
}

const PROGRESSED = new Set(['Delayed', 'Live', 'Finished', 'Walkover', 'Cancelled']);
const statusMemory = new Map();

export function resetFixtureStatusMemoryForTests() {
    statusMemory.clear();
}

function stickyId(tour, row) {
    const matchKey = row?.matchKey == null || row.matchKey === '' ? '' : String(row.matchKey);
    if (!matchKey) return '';
    return `${tour}:${matchKey}:${fixtureCompositeKey(row)}`;
}

function priorStatuses(tour, rows) {
    const out = [];
    for (const row of rows || []) {
        const saved = statusMemory.get(stickyId(tour, row));
        if (saved) out.push(saved);
    }
    return out;
}

function rememberStatuses(tour, rows) {
    for (const row of rows || []) {
        const id = stickyId(tour, row);
        if (!id) continue;
        if (!PROGRESSED.has(row?.status)) {
            statusMemory.delete(id);
            continue;
        }
        const saved = {
            matchKey: row.matchKey,
            player1Key: row.player1Key,
            player2Key: row.player2Key,
            tournamentKey: row.tournamentKey,
            roundId: row.roundId,
            status: row.status,
            isLive: row.status === 'Live',
            setScores: Array.isArray(row.setScores) ? row.setScores.slice() : [],
            winner: typeof row.winner === 'string' ? row.winner : '',
            currentGame: row.currentGame ?? null,
        };
        withTrustedStart(saved, row.startsAtUtc);
        tagWalkoverKind(saved, walkoverKindOf(row));
        statusMemory.set(id, saved);
    }
}

function envelopeTime(envelope) {
    if (!envelope || typeof envelope !== 'object') return '';
    for (const key of ['fetchedAt', 'cachedAt']) {
        const value = envelope[key];
        if (typeof value !== 'string' || !value) continue;
        const ms = Date.parse(value);
        if (!Number.isFinite(ms) || ms <= 0) continue;
        return new Date(ms).toISOString();
    }
    return '';
}

function livescoreRows(envelope) {
    const data = envelope?.data;
    if (!Array.isArray(data)) return [];
    return data.filter(row => row && typeof row === 'object');
}

function drawRows(envelope, tournamentKey) {
    const rounds = envelope?.data?.rounds;
    if (!Array.isArray(rounds)) return [];
    const out = [];
    for (const round of rounds) {
        const matches = round?.matches;
        if (!Array.isArray(matches)) continue;
        for (const match of matches) {
            if (!match || typeof match !== 'object' || match.synthetic) continue;
            out.push(match.tournamentKey ? match : { ...match, tournamentKey });
        }
    }
    return out;
}

export const MAX_FIXTURE_DRAW_READS = 5;
export const FIXTURE_OVERLAY_EDGE_TTL = 60;

function isTourRow(row) {
    if (row?.tier === 'tour') return true;
    if (row?.tier === 'challenger' || row?.tier === 'itf') return false;
    return fixtureTier({
        tournamentName: row?.tournamentName,
        eventType: row?.eventType,
    }) === 'tour';
}

// Requested tournamentKey first, then tour-tier events already on the page.
// Hard stop at 5 so an unauthenticated fixtures view cannot fan out draws.
function drawTournamentIds(query, rows) {
    const ids = [];
    const seen = new Set();
    const add = (value) => {
        if (value == null || value === '' || ids.length >= MAX_FIXTURE_DRAW_READS) return;
        const id = String(value);
        if (seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    add(query?.tournamentKey);
    for (const row of rows || []) {
        if (!isTourRow(row)) continue;
        add(row.tournamentKey);
    }
    return ids;
}

function overlayEdgeParts(query) {
    return [
        'fixtures-overlay',
        query.tour,
        query.tournamentKey || 'all',
        query.dateStart || '',
        query.dateStop || '',
    ];
}

async function readMergedEdge(query) {
    try {
        const hit = await cache.getEdge(...overlayEdgeParts(query));
        const data = hit?.data;
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.rows)) {
            if (typeof data.asOf === 'string' && data.asOf) tagAsOf(data.rows, data.asOf);
            return data.rows;
        }
    } catch { /* edge miss is not an error */ }
    return null;
}

async function writeMergedEdge(query, rows, asOf) {
    if (!Array.isArray(rows)) return;
    // JSON clone drops symbols and anything that is not public data.
    let value;
    try {
        value = JSON.parse(JSON.stringify(rows));
    } catch {
        return;
    }
    if (!Array.isArray(value)) return;
    const stored = asOf ? { rows: value, asOf } : value;
    try {
        await cache.setEdge(FIXTURE_OVERLAY_EDGE_TTL, stored, ...overlayEdgeParts(query));
    } catch { /* edge put is already fail-soft */ }
}

async function readCache(env, parts) {
    try {
        return await cache.get(env, ...parts);
    } catch {
        return null;
    }
}

// Plain cache/KV reads. Never calls handleLivescore or any RapidAPI path,
// so a cache miss cannot spend an upstream call.
async function loadCachedOverlay(env, query, rows) {
    const tour = query.tour;
    const overlays = [];
    let statusAsOf = '';
    const take = (envelope, list) => {
        if (!list.length) return;
        overlays.push(...list);
        const time = envelopeTime(envelope);
        if (time > statusAsOf) statusAsOf = time;
    };

    const boards = [
        ['livescore3', tour, 'all'],
        ['livescore3', tour, 'all', 'last'],
    ];
    if (query.tournamentKey) {
        const tid = String(query.tournamentKey);
        boards.push(
            ['livescore3', tour, tid],
            ['livescore3', tour, tid, 'last'],
        );
    }
    for (const parts of boards) {
        const envelope = await readCache(env, parts);
        take(envelope, livescoreRows(envelope));
    }
    for (const tid of drawTournamentIds(query, rows)) {
        const envelope = await readCache(env, [DRAWS_CACHE_RESOURCE, tid, tour]);
        take(envelope, drawRows(envelope, tid));
    }
    return { overlays, statusAsOf };
}

async function overlayFromCache(env, query, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return Array.isArray(rows) ? rows : [];
    const { overlays, statusAsOf } = await loadCachedOverlay(env, query, rows);
    const hadCache = overlays.length > 0;
    const prior = hadCache ? priorStatuses(query.tour, rows) : [];
    const merged = applyFixtureOverlay(rows, prior.concat(overlays), {
        now: new Date(),
        statusAsOf: hadCache ? statusAsOf : '',
    });
    if (hadCache) rememberStatuses(query.tour, merged);
    return merged;
}

async function deliverFixtures(env, query, rows) {
    const asOf = readAsOf(rows);
    let next = rows;
    try {
        next = await overlayFromCache(env, query, rows);
    } catch {
        next = Array.isArray(rows) ? applyFixtureOverlay(rows, [], { statusAsOf: '' }) : [];
    }
    if (asOf) tagAsOf(next, asOf);
    await writeMergedEdge(query, next, asOf);
    return next;
}
