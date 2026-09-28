import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from './index.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIRST = '2026-09-28T15:00:00.000Z';
const LATER = '2026-09-28T15:06:00.000Z';

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

describe('X-Fetched-At', () => {
    beforeEach(() => {
        installMockCaches();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(FIRST));
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.caches;
        delete globalThis.fetch;
    });

    it('sets the header on a fresh livescore fetch and reuses it on cache hit and quota stop', async () => {
        const calls = installUpstream();
        const env = mockEnv();

        const firstRes = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const first = await firstRes.json();
        expect(firstRes.status).toBe(200);
        expect(firstRes.headers.get('X-Fetched-At')).toBe(FIRST);
        expect(firstRes.headers.get('X-Fetched-At')).toMatch(ISO);
        expect(firstRes.headers.get('Access-Control-Expose-Headers')).toBeNull();
        expect(Object.keys(first).sort()).toEqual(['data', 'ok']);
        expect(Array.isArray(first.data)).toBe(true);
        expect(JSON.stringify(first)).not.toMatch(/fetchedAt|quota|ratelimit|hard stop/i);
        const fetchesAfterFill = calls.length;
        expect(fetchesAfterFill).toBeGreaterThan(0);

        vi.setSystemTime(new Date(LATER));
        const secondRes = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const second = await secondRes.json();
        expect(secondRes.headers.get('X-Fetched-At')).toBe(FIRST);
        expect(second.data).toEqual(first.data);
        expect(Object.keys(second).sort()).toEqual(['data', 'ok']);
        expect(calls).toHaveLength(fetchesAfterFill);

        env.RAPIDAPI_HARD_STOP = 'force';
        vi.setSystemTime(new Date('2026-09-28T15:20:00.000Z'));
        const stoppedRes = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        const stopped = await stoppedRes.json();
        expect(stoppedRes.headers.get('X-Fetched-At')).toBe(FIRST);
        expect(Object.keys(stopped).sort()).toEqual(['data', 'ok']);
        expect(calls).toHaveLength(fetchesAfterFill);
        for (const [k, v] of stoppedRes.headers) {
            expect(`${k}: ${v}`).not.toMatch(/quota|ratelimit|hard stop|-6004/i);
        }
    });

    it('exposes X-Fetched-At only when the request is cross-origin', async () => {
        installUpstream();
        const env = mockEnv();
        const res = await worker.fetch(get('/api/livescore?tour=ATP', 'http://localhost:3000'), env);
        expect(res.headers.get('X-Fetched-At')).toBe(FIRST);
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
