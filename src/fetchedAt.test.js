import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from './index.js';
import { LIVESCORE_FETCHED_AT_UNKNOWN } from './fetchedAt.js';
import { resetLivescoreFetchMemoryForTests } from './routes/livescore.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIRST = '2026-09-28T15:00:00.000Z';
const LATER = '2026-09-28T15:06:00.000Z';
const ORIGINAL = '2026-09-28T14:00:00.000Z';
const BOARD = [{
    matchKey: '9',
    isLive: true,
    status: 'Live',
    player1Name: 'A',
    player2Name: 'B',
    setScores: ['1-0'],
}];
const EDGE_BOARD = 'https://tennisworld-cache.internal/tw:livescore3:ATP:all';

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
            async delete(req) {
                store.delete(urlOf(req));
            },
            _store: store,
        },
    };
}

function mockEnv() {
    const store = new Map();
    return {
        RAPIDAPI_KEY: 'dummy-rapidapi-key',
        CORS_ORIGIN: 'https://tennisworld-api.nicomontoya.workers.dev',
        TENNIS_CACHE: {
            async get(key, type) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json' || type?.type === 'json') {
                    try { return JSON.parse(raw); } catch { return raw; }
                }
                return raw;
            },
            async put(key, value) { store.set(key, value); },
            async delete(key) { store.delete(key); },
            _store: store,
        },
    };
}

function get(path, origin) {
    const headers = { 'CF-Connecting-IP': '203.0.113.77' };
    if (origin) headers.Origin = origin;
    return new Request(`https://example.test${path}`, { headers });
}

function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status });
}

function installUpstream() {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        calls.push(String(url));
        const u = String(url);
        if (u.includes('/extend/api/events/live')) {
            return jsonRes({
                success: true,
                results: [{
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
                }],
                count: 1,
            });
        }
        if (u.includes('/tournament/calendar') && /pageNo=1/.test(u)) {
            return jsonRes({ data: [{ id: 20340, name: 'US Open', tier: 'Grand Slam', date: '2026-09-28' }] });
        }
        if (u.includes('/tournament/calendar')) return jsonRes({ data: [] });
        if (u.includes('/fixtures/tournament/')) return jsonRes({ data: [] });
        if (u.includes('/tournament/results/')) return jsonRes({ data: { singles: [] } });
        return jsonRes({}, 404);
    });
    return calls;
}

function installUpstreamError() {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        calls.push(String(url));
        return jsonRes({ error: true }, 500);
    });
    return calls;
}

async function seedStale(env, fetchedAt = ORIGINAL) {
    await env.TENNIS_CACHE.put('tw:livescore3:ATP:all:stale', JSON.stringify({
        data: BOARD,
        fetchedAt,
        cachedAt: fetchedAt,
        stale: true,
    }));
}

function assertFetchedAt(res, expected) {
    const header = res.headers.get('X-Fetched-At');
    expect(header, 'X-Fetched-At must be present').toBeTruthy();
    expect(header).toMatch(ISO);
    expect(Number.isNaN(Date.parse(header))).toBe(false);
    expect(header).toBe(expected);
    for (const [k, v] of res.headers) {
        expect(`${k}: ${v}`).not.toMatch(/quota|ratelimit|hard stop|-6004/i);
    }
}

describe('X-Fetched-At', () => {
    beforeEach(() => {
        installMockCaches();
        resetLivescoreFetchMemoryForTests();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(FIRST));
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.caches;
        delete globalThis.fetch;
    });

    it('fresh upstream fetch sets X-Fetched-At to that fetch time', async () => {
        installUpstream();
        const env = mockEnv();
        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        assertFetchedAt(res, FIRST);
        expect(Array.isArray(body.data)).toBe(true);
        expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
        expect(JSON.stringify(body)).not.toMatch(/fetchedAt|quota|ratelimit|hard stop/i);
    });

    it('edge-cache hit returns the original X-Fetched-At', async () => {
        const calls = installUpstream();
        const env = mockEnv();
        const first = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const firstBody = await first.json();
        assertFetchedAt(first, FIRST);
        const fetchesAfterFill = calls.length;

        vi.setSystemTime(new Date(LATER));
        const second = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const secondBody = await second.json();
        assertFetchedAt(second, FIRST);
        expect(secondBody.data).toEqual(firstBody.data);
        expect(calls).toHaveLength(fetchesAfterFill);
    });

    it('does not KV put on the livescore fetch path', async () => {
        installUpstream();
        const env = mockEnv();
        const puts = [];
        env.TENNIS_CACHE.put = async (key, value) => {
            puts.push(String(key));
            env.TENNIS_CACHE._store.set(key, value);
        };
        // Yearly calendar is already stored, so this request must not put.
        await env.TENNIS_CACHE.put('tw:calendar-year:ATP:2026', JSON.stringify({
            data: { data: [{ id: 20340, name: 'US Open', tier: 'Grand Slam', date: '2026-09-28' }] },
            cachedAt: FIRST,
            stale: false,
        }));
        puts.length = 0;

        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        assertFetchedAt(res, FIRST);
        expect(Array.isArray(body.data)).toBe(true);
        expect(puts).toEqual([]);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => String(k).includes('livescore'))).toEqual([]);
    });

    it('ignores a KV stale copy and does not put while resolving the fetch time', async () => {
        const calls = installUpstreamError();
        const env = mockEnv();
        const puts = [];
        const origPut = env.TENNIS_CACHE.put.bind(env.TENNIS_CACHE);
        env.TENNIS_CACHE.put = async (key, value) => {
            puts.push(String(key));
            return origPut(key, value);
        };
        await seedStale(env);
        puts.length = 0;
        vi.setSystemTime(new Date(LATER));

        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        assertFetchedAt(res, LIVESCORE_FETCHED_AT_UNKNOWN);
        expect(body.data).toEqual([]);
        expect(puts).toEqual([]);
        expect(calls.length).toBeGreaterThan(0);
    });

    it('hard-stop fallback returns the original X-Fetched-At from the edge entry and does not fetch', async () => {
        installUpstream();
        const env = mockEnv();
        const filled = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const filledBody = await filled.json();
        assertFetchedAt(filled, FIRST);

        env.RAPIDAPI_HARD_STOP = 'force';
        globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
        vi.setSystemTime(new Date(LATER));

        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        assertFetchedAt(res, FIRST);
        expect(body.data).toEqual(filledBody.data);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('upstream error fallback returns the original X-Fetched-At from isolate memory', async () => {
        installUpstream();
        const env = mockEnv();
        const filled = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        assertFetchedAt(filled, FIRST);

        globalThis.caches.default._store.delete(EDGE_BOARD);
        installUpstreamError();
        vi.setSystemTime(new Date(LATER));

        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        assertFetchedAt(res, FIRST);
        expect(body.data).toEqual([]);
    });

    it('uses the last successful fetch time from isolate memory when the board cache is gone', async () => {
        installUpstream();
        const env = mockEnv();
        const filled = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        assertFetchedAt(filled, FIRST);

        globalThis.caches.default._store.delete(EDGE_BOARD);
        env.RAPIDAPI_HARD_STOP = 'force';
        globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
        vi.setSystemTime(new Date(LATER));

        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        assertFetchedAt(res, FIRST);
        expect(body.data).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('uses the epoch when no fetch time is known and the board is empty', async () => {
        globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
        const env = mockEnv();
        env.RAPIDAPI_HARD_STOP = 'force';

        const stopped = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const stoppedBody = await stopped.json();
        expect(stopped.status).toBe(200);
        assertFetchedAt(stopped, LIVESCORE_FETCHED_AT_UNKNOWN);
        expect(stoppedBody.data).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();

        globalThis.caches.default._store.clear();
        const failed = mockEnv();
        installUpstreamError();
        const errored = await worker.fetch(get('/api/livescore?tour=ATP'), failed);
        const erroredBody = await errored.json();
        expect(errored.status).toBe(200);
        assertFetchedAt(errored, LIVESCORE_FETCHED_AT_UNKNOWN);
        expect(erroredBody.data).toEqual([]);
    });

    it('still sends X-Fetched-At when the livescore request is rejected', async () => {
        const env = mockEnv();
        const res = await worker.fetch(get('/api/livescore?tour=ITF'), env);
        expect(res.status).toBe(400);
        assertFetchedAt(res, LIVESCORE_FETCHED_AT_UNKNOWN);
    });

    it('exposes X-Fetched-At only when the request is cross-origin', async () => {
        installUpstream();
        const env = mockEnv();
        const res = await worker.fetch(get('/api/livescore?tour=ATP', 'http://localhost:3000'), env);
        assertFetchedAt(res, FIRST);
        expect(res.headers.get('Access-Control-Expose-Headers')).toBe('X-Fetched-At');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    });

    it('does not put X-Fetched-At on the hub response', async () => {
        globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
        const env = mockEnv();
        const res = await worker.fetch(get('/api/hub?tour=ATP', 'http://localhost:3000'), env);
        expect(res.headers.get('X-Fetched-At')).toBeNull();
        expect(res.headers.get('Access-Control-Expose-Headers')).toBeNull();
    });
});
