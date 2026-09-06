import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleLivescore } from './livescore.js';
import { handleHub } from './hub.js';
import { handleDraws } from './draws.js';
import { handleFixtures } from './fixtures.js';
import { RL_PER_MINUTE, rateLimitCacheUrl } from '../security.js';
import worker from '../index.js';

function mockEnv() {
    const store = new Map();
    return {
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
    const cache = {
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
    };
    globalThis.caches = { default: cache };
    return cache;
}

async function seedRateLimit(bucket, ip, count = RL_PER_MINUTE.max) {
    await caches.default.put(rateLimitCacheUrl(bucket, ip), new Response(
        JSON.stringify({ count, windowStart: Date.now() }),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } },
    ));
}

function get(path, ip) {
    const headers = {};
    if (ip) headers['CF-Connecting-IP'] = ip;
    return new Request(`https://example.test${path}`, { headers });
}

async function expectReject(promise, status, messageRe) {
    await expect(promise).rejects.toMatchObject({
        status,
        message: expect.stringMatching(messageRe),
    });
}

describe('GET /api/livescore security', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
    });
    afterEach(() => { delete globalThis.caches; });

    it('rejects junk tour and junk/empty tournamentKey with 400 before cache/upstream', async () => {
        await expectReject(handleLivescore(get('/api/livescore?tour=ITF'), env), 400, /ATP or WTA/i);
        await expectReject(handleLivescore(get('/api/livescore?tournamentKey=abc'), env), 400, /digits only/i);
        await expectReject(handleLivescore(get('/api/livescore?tournamentKey='), env), 400, /tournamentKey/i);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('tw:'))).toEqual([]);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('_rl:'))).toEqual([]);
    });

    it('returns 429 on the 61st request per IP (bucket livescore) without writing KV', async () => {
        await seedRateLimit('livescore', '203.0.113.4');
        await expectReject(
            handleLivescore(get('/api/livescore?tour=ATP', '203.0.113.4'), env),
            429,
            /too many requests/i,
        );
        expect([...env.TENNIS_CACHE._store.keys()]).toEqual([]);
    });
});

describe('GET /api/hub security', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
    });
    afterEach(() => { delete globalThis.caches; });

    it('rejects junk tour with 400 so it cannot fan hub cache keys', async () => {
        await expectReject(handleHub(get('/api/hub?tour=CHALLENGER'), env), 400, /ATP or WTA/i);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('tw:'))).toEqual([]);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('_rl:'))).toEqual([]);
    });

    it('returns 429 on the 61st request per IP (bucket hub) without writing KV', async () => {
        await seedRateLimit('hub', '203.0.113.4');
        await expectReject(
            handleHub(get('/api/hub?tour=WTA', '203.0.113.4'), env),
            429,
            /too many requests/i,
        );
        expect([...env.TENNIS_CACHE._store.keys()]).toEqual([]);
    });
});

describe('GET /api/draws + /api/fixtures tournamentKey', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
    });
    afterEach(() => { delete globalThis.caches; });

    it('draws: missing key is 400 (not 500); junk key and junk tour are 400', async () => {
        await expectReject(handleDraws(get('/api/draws'), env), 400, /required/i);
        await expectReject(handleDraws(get('/api/draws?tournamentKey=not-a-key'), env), 400, /digits only/i);
        await expectReject(handleDraws(get('/api/draws?tournamentKey=123&tour=ITF'), env), 400, /ATP or WTA/i);
    });

    it('fixtures: junk tournamentKey is 400 and does not mint a cache key', async () => {
        await expectReject(handleFixtures(get('/api/fixtures?tournamentKey=../../x'), env), 400, /digits only/i);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('tw:'))).toEqual([]);
    });
});

describe('worker JSON contract', () => {
    afterEach(() => { delete globalThis.caches; });

    it('maps hub 429 and livescore 400 through jsonResponse { ok:false, error }', async () => {
        const env = mockEnv();
        env.CORS_ORIGIN = '*';
        installMockCaches();
        await seedRateLimit('hub', '203.0.113.4');

        const limited = await worker.fetch(get('/api/hub?tour=ATP', '203.0.113.4'), env);
        expect(limited.status).toBe(429);
        expect(await limited.json()).toEqual({
            ok: false,
            error: expect.stringMatching(/too many requests/i),
        });
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('_rl:'))).toEqual([]);

        const bad = await worker.fetch(get('/api/livescore?tournamentKey=not-digits'), env);
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({
            ok: false,
            error: expect.stringMatching(/digits only/i),
        });
    });
});
