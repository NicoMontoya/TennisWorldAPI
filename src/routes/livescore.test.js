import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleLivescore, livescoreTtlFor } from './livescore.js';
import { TTL } from '../config.js';
import { cache } from '../cache.js';
import worker from '../index.js';

// Dummy env value only — never a real secret. Must not appear in client JSON.
const DUMMY_KEY = 'dummy-rapidapi-key';

const LIVE_URL = 'https://tennis-api-atp-wta-itf.p.rapidapi.com/tennis/v2/extend/api/events/live';
const API_TENNIS = 'api.api-tennis.com';

const inPlayEvent = {
    id: '3815731',
    name: 'J. Sinner vs C. Alcaraz',
    participant1: 'J. Sinner',
    participant2: 'C. Alcaraz',
    league: 'US Open',
    score: '6-4, 3-2',
    status: 'InPlay',
    points: '30-15',
    tourType: 'ATP',
    startTimestamp: 1757180000,
    matchId: '2072-2315-20340-12',
};

const today = new Date().toISOString().slice(0, 10);
const mainTour = { id: 20340, name: 'US Open', tier: 'Grand Slam', date: today };
const fixture = {
    id: 555,
    player1Id: 2072,
    player2Id: 2315,
    player1: { name: 'J. Sinner' },
    player2: { name: 'C. Alcaraz' },
    seed1: '1',
    seed2: '2',
    roundId: 12,
    date: today,
};

function mockEnv() {
    const store = new Map();
    return {
        RAPIDAPI_KEY: DUMMY_KEY,
        CORS_ORIGIN: '*',
        TENNIS_CACHE: {
            async get(key, type) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json' || type?.type === 'json') {
                    try { return JSON.parse(raw); } catch { return raw; }
                }
                return raw;
            },
            async put(key, value) {
                store.set(key, value);
            },
            _store: store,
        },
    };
}

function urlOf(req) {
    return typeof req === 'string' ? req : req.url;
}

function installMockCaches() {
    const store = new Map();
    globalThis.caches = {
        default: {
            async match(req) {
                const entry = store.get(urlOf(req));
                if (!entry) return undefined;
                return new Response(entry.body, { status: 200, headers: entry.headers });
            },
            async put(req, response) {
                const headers = {};
                response.headers.forEach((v, k) => { headers[k] = v; });
                store.set(urlOf(req), {
                    body: await response.clone().text(),
                    headers,
                });
            },
            _store: store,
        },
    };
}

function get(path) {
    return new Request(`https://example.test${path}`, {
        headers: { 'CF-Connecting-IP': '203.0.113.50' },
    });
}

function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status });
}

function installFetch({ liveEvents = [inPlayEvent], fixtures = [fixture], results = [] } = {}) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
        const u = String(url);
        calls.push({ url: u, headers: init?.headers || {} });
        if (u.includes('api.api-tennis.com') || u.includes('get_livescore')) {
            throw new Error('api-tennis.com must not be called from /api/livescore');
        }
        if (u.includes('/extend/api/events/live')) {
            // Production MatchStat Extend envelope is { success, results, count }.
            return jsonRes({ success: true, results: liveEvents, count: liveEvents.length });
        }
        if (u.includes('/tournament/calendar') && /pageNo=1/.test(u)) {
            return jsonRes({ data: [mainTour] });
        }
        if (u.includes('/tournament/calendar')) {
            return jsonRes({ data: [] });
        }
        if (u.includes('/fixtures/tournament/')) {
            return jsonRes({ data: fixtures });
        }
        if (u.includes('/tournament/results/')) {
            return jsonRes({ data: { singles: results } });
        }
        return jsonRes({ error: true, message: `unexpected ${u}` }, 404);
    });
    return calls;
}

describe('GET /api/livescore MatchStat live-first', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
    });
    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    it('fetches Extend events/live with RapidAPI headers and never api-tennis', async () => {
        const calls = installFetch();
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);

        expect(calls.some(c => c.url === LIVE_URL)).toBe(true);
        expect(calls.some(c => c.url.includes(API_TENNIS) || c.url.includes('get_livescore'))).toBe(false);
        const liveCall = calls.find(c => c.url === LIVE_URL);
        expect(liveCall.headers['X-RapidAPI-Host']).toBe('tennis-api-atp-wta-itf.p.rapidapi.com');
        expect(liveCall.headers['X-RapidAPI-Key']).toBe(DUMMY_KEY);

        expect(data.some(m => m.isLive)).toBe(true);
        const live = data.find(m => m.isLive);
        expect(live.matchKey).toBe('555');
        expect(live.matchKey).not.toBe('3815731');
        expect(live.setScores).toEqual(['6-4', '3-2']);
        expect(live.currentGame).toBe('30 - 15');
        expect(live.status).toBe('Live');
    });

    it('is not live-from-fixtures-only: empty live + scheduled fixtures stay isLive false', async () => {
        installFetch({ liveEvents: [] });
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(data.length).toBeGreaterThan(0);
        expect(data.every(m => m.isLive === false)).toBe(true);
        expect(data.every(m => m.status === 'Not Started' || m.status === 'Finished')).toBe(true);
    });

    it('live InPlay overlays a Not Started fixture so fixtures are not the sole live source', async () => {
        installFetch();
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        const row = data.find(m => m.matchKey === '555');
        expect(row.isLive).toBe(true);
        expect(row.setScores).toEqual(['6-4', '3-2']);
        expect(globalThis.fetch.mock.calls.some(([url]) => String(url) === LIVE_URL)).toBe(true);
    });

    it('filters live events by tourType (ATP) and drops WTA / ITF / Challenger', async () => {
        installFetch({
            liveEvents: [
                inPlayEvent,
                { ...inPlayEvent, id: '2', tourType: 'WTA', matchId: '10-20-20340-9', participant1: 'WTA A' },
                { ...inPlayEvent, id: '3', tourType: 'ITF', matchId: '11-21-20340-9', participant1: 'ITF A' },
                { ...inPlayEvent, id: '4', tourType: 'Challenger', matchId: '12-22-20340-9', participant1: 'Ch A' },
                { ...inPlayEvent, id: '5', tourType: 'ATP', league: 'M25 Cary', matchId: '13-23-20340-9', participant1: 'M25 A' },
            ],
        });
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        const live = data.filter(m => m.isLive);
        expect(live).toHaveLength(1);
        expect(live[0].player1Name).toBe('J. Sinner');
        expect(data.some(m => /ITF A|Ch A|WTA A|M25 A/.test(m.player1Name))).toBe(false);
    });

    it('filters live events by tournamentKey via the matchId tournament segment', async () => {
        installFetch({
            liveEvents: [
                inPlayEvent,
                { ...inPlayEvent, id: '9', matchId: '1-2-99999-12', participant1: 'Other Draw' },
            ],
        });
        const data = await handleLivescore(get('/api/livescore?tour=ATP&tournamentKey=20340'), env);
        expect(data.filter(m => m.isLive)).toHaveLength(1);
        expect(data.some(m => m.player1Name === 'Other Draw')).toBe(false);
        expect(data.find(m => m.isLive).tournamentKey).toBe('20340');
    });

    it('uses 30s TTL on match-day fixtures-only so new InPlay is not trapped for 120s', async () => {
        const setSpy = vi.spyOn(cache, 'set');
        installFetch({ liveEvents: [] });
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(data.every(m => m.isLive === false)).toBe(true);
        expect(data.some(m => m.status === 'Not Started')).toBe(true);
        expect(setSpy).toHaveBeenCalledWith(
            env,
            TTL.livescore,
            expect.any(Array),
            'livescore3',
            'ATP',
            'all',
            { skipStale: true },
        );
        expect(setSpy).not.toHaveBeenCalledWith(
            env,
            TTL.livescoreIdle,
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );

        setSpy.mockClear();
        env.TENNIS_CACHE._store.clear();
        caches.default._store.clear();
        installFetch({ liveEvents: [inPlayEvent] });
        await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(setSpy).toHaveBeenCalledWith(
            env,
            TTL.livescore,
            expect.any(Array),
            'livescore3',
            'ATP',
            'all',
            { skipStale: true },
        );
    });

    it('uses idle TTL only when the board is finished-only / empty', async () => {
        expect(livescoreTtlFor([])).toBe(TTL.livescoreIdle);
        expect(livescoreTtlFor([{ isLive: false, status: 'Finished' }])).toBe(TTL.livescoreIdle);
        expect(livescoreTtlFor([{ isLive: false, status: 'Not Started' }])).toBe(TTL.livescore);
        expect(livescoreTtlFor([{ isLive: true, status: 'Live' }])).toBe(TTL.livescore);

        const setSpy = vi.spyOn(cache, 'set');
        const finished = {
            id: 777,
            player1Id: 1,
            player2Id: 2,
            player1: { name: 'Ada' },
            player2: { name: 'Bob' },
            match_winner: 1,
            result: '6-4 6-3',
            roundId: 12,
            date: today,
        };
        installFetch({ liveEvents: [], fixtures: [], results: [finished] });
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(data.every(m => m.status === 'Finished')).toBe(true);
        expect(setSpy).toHaveBeenCalledWith(
            env,
            TTL.livescoreIdle,
            expect.any(Array),
            'livescore3',
            'ATP',
            'all',
            { skipStale: true },
        );
    });

    it('worker: mocked MatchStat live is public 200 and never echoes the env key', async () => {
        installFetch();
        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.data.some(m => m.isLive)).toBe(true);
        const row = body.data.find(m => m.isLive);
        expect(row).toMatchObject({
            matchKey: expect.any(String),
            player1Name: expect.any(String),
            player1Key: expect.any(String),
            player2Name: expect.any(String),
            player2Key: expect.any(String),
            isLive: true,
            status: 'Live',
            setScores: expect.any(Array),
        });
        const dumped = JSON.stringify(body);
        expect(dumped).not.toContain(DUMMY_KEY);
        expect(dumped).not.toMatch(/RAPIDAPI_KEY|TENNIS_API_KEY|X-RapidAPI-Key/i);
        expect(dumped).not.toMatch(/api-tennis|get_livescore/i);
    });

    it('worker: { results } envelope is 200 non-empty Match[]; junk tour still 400', async () => {
        installFetch();
        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
        expect(body.data.some(m => m.isLive && Array.isArray(m.setScores))).toBe(true);

        const junk = await worker.fetch(get('/api/livescore?tour=ITF'), env);
        expect(junk.status).toBe(400);
        const junkBody = await junk.json();
        expect(junkBody).toEqual({
            ok: false,
            error: expect.stringMatching(/ATP or WTA/i),
        });
    });

    it('upstream error with a key-shaped message does not leak to the client', async () => {
        const logs = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
        vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' ')));
        globalThis.fetch = vi.fn(async (url) => {
            const u = String(url);
            if (u.includes('/extend/api/events/live')) {
                return jsonRes({
                    error: true,
                    message: `invalid key ${DUMMY_KEY} at /extend/api/events/live`,
                });
            }
            if (u.includes('/tournament/calendar') && /pageNo=1/.test(u)) {
                return jsonRes({ data: [mainTour] });
            }
            if (u.includes('/tournament/calendar')) return jsonRes({ data: [] });
            if (u.includes('/fixtures/tournament/')) return jsonRes({ data: [fixture] });
            if (u.includes('/tournament/results/')) return jsonRes({ data: { singles: [] } });
            return jsonRes({}, 404);
        });
        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        const dumped = JSON.stringify(body);
        expect(dumped).not.toContain(DUMMY_KEY);
        expect(dumped).not.toMatch(/RapidAPI|invalid key|extend\/api/i);
        expect(logs.join('\n')).not.toContain(DUMMY_KEY);
    });

    it('fails soft when live events error and still returns Core fixtures', async () => {
        globalThis.fetch = vi.fn(async (url) => {
            const u = String(url);
            if (u.includes('/extend/api/events/live')) return jsonRes({ error: true }, 500);
            if (u.includes('/tournament/calendar') && /pageNo=1/.test(u)) {
                return jsonRes({ data: [mainTour] });
            }
            if (u.includes('/tournament/calendar')) return jsonRes({ data: [] });
            if (u.includes('/fixtures/tournament/')) return jsonRes({ data: [fixture] });
            if (u.includes('/tournament/results/')) return jsonRes({ data: { singles: [] } });
            return jsonRes({}, 404);
        });
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(data.some(m => m.matchKey === '555' && m.isLive === false)).toBe(true);
    });
});
