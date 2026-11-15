import { cache } from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL } from '../config.js';
import { parseTour, parseTournamentKey } from '../security.js';
import { normalizeFixturesFeed } from '../transforms/fixturesFeed.js';
import { dedupeFixtures, orderFixturesByTier, selectTourTarget } from '../transforms/fixtureTier.js';
import { tagAsOf } from '../asOf.js';
import { readFixtures, readTournaments, rememberFixtures } from '../d1Store.js';

// Two upstream calls, same as before. The first is a tournament-specific
// fixtures read when a live/upcoming tour event is already in D1 or the
// calendar-year cache (no calendar fetch). The remaining call is one page of
// the general feed. With no stored tour event, both calls stay on the general
// feed. Never a third page, and both calls still go through rapidFetch
// (claimCallSlot + hard stop).
const MAX_CALLS = 2;
const PAGE_SIZE = 100;
const CALENDAR_KEY = 'calendar-year';

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

// Calendar rows already on hand. Does not call RapidAPI.
async function storedCalendarItems(env, tour) {
    const items = [];
    try {
        const saved = await readTournaments(env, tour);
        if (Array.isArray(saved?.rows)) items.push(...saved.rows);
    } catch { /* D1 miss is not a reason to fetch */ }

    const year = new Date().getUTCFullYear();
    for (const y of [year - 1, year, year + 1]) {
        const key = [CALENDAR_KEY, tour, String(y)];
        try {
            items.push(...calendarItems(await cache.get(env, ...key)));
        } catch { /* cache miss */ }
        try {
            items.push(...calendarItems(await cache.getStale(env, ...key)));
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
    const target = selectTourTarget(await storedCalendarItems(env, tour), new Date(), query);
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

    let cached = null;
    try {
        cached = await cache.get(env, ...cacheKey);
    } catch {
        cached = null;
    }
    if (cached && Array.isArray(cached.data)) {
        const live = cached.data.filter(row => row?.matchKey);
        if (live.length) return live;
        // Short-TTL empty. Do not pay for another pull until it expires,
        // and do not hide D1 last-good behind that [].
        if (cached.data.length === 0) return serveStoredFixtures(env, cacheKey, query);
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
            return serveStoredFixtures(env, cacheKey, query);
        }
        try { await rememberFixtures(env, tour, live); } catch { /* last-good is best-effort */ }
        try { await cache.set(env, TTL.fixtures, live, ...cacheKey); } catch { /* cache is fail-soft */ }
        return live;
    } catch {
        return serveStoredFixtures(env, cacheKey, query);
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
