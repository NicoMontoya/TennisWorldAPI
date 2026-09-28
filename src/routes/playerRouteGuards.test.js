import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { cache } from '../cache.js';
import { RL_PER_MINUTE, rateLimitCacheUrl } from '../security.js';

const YEAR = new Date().getFullYear();
const SINNER = '206173';

function mockEnv() {
    const store = new Map();
    const puts = [];
    let gets = 0;
    return {
        CORS_ORIGIN: '*',
        RAPIDAPI_KEY: 'test-rapid-key',
        gets: () => gets,
        resetGets() { gets = 0; },
        TENNIS_CACHE: {
            async get(key, type) {
                gets++;
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json' || type?.type === 'json') {
                    try { return JSON.parse(raw); } catch { return raw; }
                }
                return raw;
            },
            async put(key, value, opts) {
                puts.push({ key, opts });
                store.set(key, value);
            },
            async delete(key) { store.delete(key); },
            _store: store,
            _puts: puts,
        },
    };
}

function cacheUrl(req) {
    return typeof req === 'string' ? req : req.url;
}

function installMockCaches() {
    const store = new Map();
    globalThis.caches = {
        default: {
            async match(req) {
                const entry = store.get(cacheUrl(req));
                if (!entry) return undefined;
                return new Response(entry.body, { headers: entry.headers });
            },
            async put(req, res) {
                const headers = {};
                res.headers.forEach((v, k) => { headers[k] = v; });
                store.set(cacheUrl(req), { body: await res.text(), headers });
            },
            async delete(req) {
                return store.delete(cacheUrl(req));
            },
            _store: store,
        },
    };
    return store;
}

function installFetch(route) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        calls.push(u);
        return new Response(JSON.stringify(route(u)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    return calls;
}

function get(path, ip) {
    const headers = {};
    if (ip) headers['CF-Connecting-IP'] = ip;
    return new Request(`https://tennisworld-api.nicomontoya.workers.dev${path}`, { headers });
}

function emptyData(path) {
    if (path === '/api/player-stats') {
        return {
            titles: 0,
            form: [],
            wins: 0,
            losses: 0,
            winPct: null,
            surface: {
                hard:  { wins: 0, losses: 0 },
                clay:  { wins: 0, losses: 0 },
                grass: { wins: 0, losses: 0 },
            },
            birthday: null,
        };
    }
    return { seasons: [], careerTitles: 0 };
}

function sinnerMatch() {
    return {
        id: 1,
        date: `${YEAR}-06-15`,
        match_winner: Number(SINNER),
        tournamentId: 1001,
        roundId: 7,
        tournament: { id: 1001, court: { name: 'Hard' } },
    };
}

function upstreamFor(url) {
    if (url.includes('/player/past-matches/')) {
        if (url.includes(`/player/past-matches/${SINNER}`)) return { data: [sinnerMatch()] };
        return { data: [] };
    }
    if (url.includes('/player/titles/')) return { data: [] };
    if (url.includes('/player/profile/')) {
        return { data: { birthday: '2001-08-16T00:00:00.000Z' } };
    }
    if (url.includes('/tournament/calendar/') && url.includes('pageNo=1')) {
        return { data: [{ id: 1001, name: 'Test Open', court: { name: 'Hard' }, rankId: 4 }] };
    }
    if (url.includes('/tournament/calendar/')) return { data: [] };
    return { data: [] };
}

const ROUTES = [
    { path: '/api/player-stats', bucket: 'player-stats', miss: 'player-stats-miss' },
    { path: '/api/player-history', bucket: 'player-history', miss: 'player-history-miss' },
];

describe('player-stats and player-history guards', () => {
    let env;
    let fetchCalls;
    let edgeSpy;

    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        fetchCalls = installFetch(upstreamFor);
        edgeSpy = vi.spyOn(cache, 'setEdge');
    });

    afterEach(() => {
        edgeSpy.mockRestore();
        delete globalThis.caches;
        delete globalThis.fetch;
    });

    describe.each(ROUTES)('$path', ({ path, bucket, miss }) => {
        const badKeys = ['abc', 's103819', '1'.repeat(11), ''];

        it('returns 400 for a bad tour or playerKey and does not call fetch', async () => {
            const tourRes = await worker.fetch(get(`${path}?tour=ITF&playerKey=${SINNER}`), env);
            expect(tourRes.status).toBe(400);
            const tourBody = await tourRes.json();
            expect(tourBody).toEqual({
                ok: false,
                error: expect.stringMatching(/ATP or WTA/i),
            });
            expect(JSON.stringify(tourBody)).not.toContain('ITF');

            for (const playerKey of badKeys) {
                const q = playerKey === ''
                    ? 'playerKey='
                    : `playerKey=${encodeURIComponent(playerKey)}`;
                const res = await worker.fetch(get(`${path}?tour=ATP&${q}`), env);
                expect(res.status, playerKey || '(empty)').toBe(400);
                const body = await res.json();
                expect(body.ok).toBe(false);
                expect(body.error).toMatch(/playerKey/i);
                if (playerKey) expect(JSON.stringify(body)).not.toContain(playerKey);
            }

            expect(fetchCalls).toEqual([]);
            expect(env.gets()).toBe(0);
            expect(env.TENNIS_CACHE._puts).toHaveLength(0);
            expect(edgeSpy).not.toHaveBeenCalled();
        });

        it('returns 429 when the bucket is exhausted and fails closed without the Cache API', async () => {
            const ip = '203.0.113.40';
            await caches.default.put(rateLimitCacheUrl(bucket, ip), new Response(
                JSON.stringify({ count: RL_PER_MINUTE.max, windowStart: Date.now() }),
                { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } },
            ));
            const limited = await worker.fetch(get(`${path}?tour=ATP&playerKey=${SINNER}`, ip), env);
            expect(limited.status).toBe(429);
            expect(await limited.json()).toEqual({
                ok: false,
                error: expect.stringMatching(/too many requests/i),
            });
            expect(fetchCalls).toEqual([]);
            expect(env.gets()).toBe(0);
            expect(env.TENNIS_CACHE._puts).toHaveLength(0);

            delete globalThis.caches;
            const closed = await worker.fetch(get(`${path}?tour=ATP&playerKey=${SINNER}`, '203.0.113.41'), env);
            expect(closed.status).toBe(429);
            expect((await closed.json()).error).toMatch(/too many requests/i);
            expect(fetchCalls).toEqual([]);
            expect(env.TENNIS_CACHE._puts).toHaveLength(0);
        });

        it('stores an empty upstream result as one edge miss and serves the repeat without fetch', async () => {
            const playerKey = '1234567890';
            const first = await worker.fetch(get(`${path}?tour=ATP&playerKey=${playerKey}`), env);
            expect(first.status).toBe(200);
            expect((await first.json()).data).toEqual(emptyData(path));
            expect(env.TENNIS_CACHE._puts).toHaveLength(0);
            expect(edgeSpy).toHaveBeenCalledTimes(1);
            expect(edgeSpy.mock.calls[0][0]).toBe(600);
            expect(edgeSpy.mock.calls[0][1]).toEqual({ miss: true });
            expect(edgeSpy.mock.calls[0].slice(2)).toEqual([miss, 'ATP', playerKey]);
            expect(fetchCalls).toHaveLength(1);
            expect(fetchCalls[0]).toContain('/player/past-matches/');

            const edge = [...caches.default._store.entries()].find(([url]) => String(url).includes(miss));
            expect(edge?.[1].headers['cache-control']).toBe('public, max-age=600');

            fetchCalls.length = 0;
            env.resetGets();
            const second = await worker.fetch(get(`${path}?tour=ATP&playerKey=${playerKey}`), env);
            expect(second.status).toBe(200);
            expect((await second.json()).data).toEqual(emptyData(path));
            expect(fetchCalls).toEqual([]);
            expect(env.gets()).toBe(0);
            expect(env.TENNIS_CACHE._puts).toHaveLength(0);
            expect(edgeSpy).toHaveBeenCalledTimes(1);
        });
    });

    it('caches a real player with matches, including titles = 0', async () => {
        const res = await worker.fetch(get(`/api/player-stats?tour=ATP&playerKey=${SINNER}`), env);
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({
            titles: 0,
            form: ['W'],
            wins: 1,
            losses: 0,
            winPct: 100,
            surface: {
                hard:  { wins: 1, losses: 0 },
                clay:  { wins: 0, losses: 0 },
                grass: { wins: 0, losses: 0 },
            },
            birthday: '2001-08-16T00:00:00.000Z',
        });

        const ttl = (key) => env.TENNIS_CACHE._puts.find(p => p.key === key)?.opts?.expirationTtl;
        expect(ttl(`tw:player-past-matches-200:ATP:${SINNER}`)).toBe(6 * 60 * 60);
        expect(ttl(`tw:player-titles:ATP:${SINNER}`)).toBe(72 * 60 * 60);
        expect(ttl(`tw:player-profile:ATP:${SINNER}`)).toBe(30 * 24 * 60 * 60);
        expect(ttl('tw:tournament-map-v6:ATP')).toBe(24 * 60 * 60);
        expect(JSON.parse(env.TENNIS_CACHE._store.get(`tw:player-titles:ATP:${SINNER}`)).data).toBe(0);
        expect(env.TENNIS_CACHE._puts.some(p => p.key === `tw:player-titles:ATP:${SINNER}:stale`)).toBe(true);
        expect(env.TENNIS_CACHE._puts.some(p => p.key === `tw:player-past-matches-200:ATP:${SINNER}:stale`)).toBe(true);
        expect(edgeSpy).not.toHaveBeenCalled();

        const callsAfterWarm = fetchCalls.length;
        expect(callsAfterWarm).toBeGreaterThan(0);
        const again = await worker.fetch(get(`/api/player-stats?tour=ATP&playerKey=${SINNER}`), env);
        expect((await again.json()).data.titles).toBe(0);
        expect(fetchCalls.length).toBe(callsAfterWarm);
    });

    it('caches player history for a player with matches and skips an empty season list', async () => {
        const res = await worker.fetch(get(`/api/player-history?tour=ATP&playerKey=${SINNER}`), env);
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({
            careerTitles: 0,
            seasons: [{
                year: YEAR,
                wins: 1,
                losses: 0,
                titles: 0,
                winPct: 100,
                hard:  { wins: 1, losses: 0 },
                clay:  { wins: 0, losses: 0 },
                grass: { wins: 0, losses: 0 },
            }],
        });

        const historyKey = `tw:player-history-v1:ATP:${SINNER}`;
        const put = env.TENNIS_CACHE._puts.find(p => p.key === historyKey);
        expect(put?.opts?.expirationTtl).toBe(12 * 60 * 60);
        expect(JSON.parse(env.TENNIS_CACHE._store.get(historyKey)).data.seasons).toHaveLength(1);
        expect(env.TENNIS_CACHE._puts.some(p => p.key === `${historyKey}:stale`)).toBe(true);
        expect(env.TENNIS_CACHE._puts.some(p => p.key === 'tw:tournament-map-v6:ATP')).toBe(true);
        expect(edgeSpy).not.toHaveBeenCalled();

        const callsAfterWarm = fetchCalls.length;
        const again = await worker.fetch(get(`/api/player-history?tour=ATP&playerKey=${SINNER}`), env);
        expect((await again.json()).data.seasons).toHaveLength(1);
        expect(fetchCalls.length).toBe(callsAfterWarm);
    });
});
