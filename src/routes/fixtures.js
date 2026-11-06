import { cache } from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL } from '../config.js';
import { parseTour, parseTournamentKey } from '../security.js';
import { normalizeFixturesFeed } from '../transforms/fixturesFeed.js';
import { tagAsOf } from '../asOf.js';
import { readFixtures, rememberFixtures } from '../d1Store.js';

const MAX_PAGES = 2;
const PAGE_SIZE = 100;

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

async function pullFixtures(env, { tour, tournamentKey, dateStart, dateStop }) {
    if (tournamentKey) {
        return rapidAPI.tournamentFixtures(env, tour, tournamentKey);
    }
    const rows = [];
    let envelope = { data: rows };
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        const json = await rapidAPI.fixturesFeed(env, tour, {
            dateStart, dateStop, pageNo, pageSize: PAGE_SIZE,
        });
        const page = Array.isArray(json?.data) ? json.data : [];
        rows.push(...page);
        envelope = json || envelope;
        if (!page.length || json?.hasNextPage === false || page.length < PAGE_SIZE) break;
    }
    return { ...envelope, data: rows };
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

    const cacheKey = ['fixtures4', tour, tournamentKey || 'all', dateStart || '', dateStop || ''];
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
        const raw = await pullFixtures(env, query);
        const data = normalizeFixturesFeed(raw, { tour, tournamentKey });
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
    if (saved?.hadRows) return tagAsOf(saved.rows, saved.asOf);

    try {
        const stale = await cache.getStale(env, ...cacheKey);
        const rows = Array.isArray(stale?.data) ? stale.data.filter(row => row?.matchKey) : [];
        if (rows.length) return tagAsOf(rows, stale.cachedAt || stale.fetchedAt);
    } catch { /* KV miss is an empty board */ }

    return [];
}
