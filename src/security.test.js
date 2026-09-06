import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    RL_PER_MINUTE,
    TOURNAMENT_KEY_RE,
    parseTour,
    parseTournamentKey,
    rateLimit,
    rateLimitCacheUrl,
} from './security.js';

function mockEnv() {
    const store = new Map();
    return {
        TENNIS_CACHE: {
            async get(key) {
                return store.has(key) ? store.get(key) : null;
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

function req(url = 'https://example.test/api/livescore', ip) {
    const headers = {};
    if (ip) headers['CF-Connecting-IP'] = ip;
    return new Request(url, { headers });
}

async function expectReject(promise, status, messageRe) {
    await expect(promise).rejects.toMatchObject({
        status,
        message: expect.stringMatching(messageRe),
    });
}

async function cacheCount(cache, bucket, ip) {
    const hit = await cache.match(rateLimitCacheUrl(bucket, ip));
    if (!hit) return undefined;
    const data = await hit.json();
    return data.count;
}

describe('parseTour', () => {
    it('defaults omitted / blank to ATP and accepts ATP|WTA case-insensitively', () => {
        expect(parseTour(null)).toBe('ATP');
        expect(parseTour(undefined)).toBe('ATP');
        expect(parseTour('')).toBe('ATP');
        expect(parseTour('  ')).toBe('ATP');
        expect(parseTour('atp')).toBe('ATP');
        expect(parseTour('WTA')).toBe('WTA');
        expect(parseTour(' wta ')).toBe('WTA');
    });

    it('rejects junk tour values with 400 so they cannot fan cache keys', () => {
        for (const junk of ['ITF', 'ATP2', 'ALL', 'atp;WTA', '../ATP', 'ATP WTA']) {
            try {
                parseTour(junk);
                expect.unreachable(`expected 400 for ${junk}`);
            } catch (err) {
                expect(err.status).toBe(400);
                expect(err.message).toMatch(/ATP or WTA/i);
            }
        }
    });
});

describe('parseTournamentKey', () => {
    it('accepts 1–20 digit keys and treats absent optional as undefined', () => {
        expect(TOURNAMENT_KEY_RE.test('123')).toBe(true);
        expect(parseTournamentKey(null)).toBeUndefined();
        expect(parseTournamentKey(undefined)).toBeUndefined();
        expect(parseTournamentKey('123')).toBe('123');
        expect(parseTournamentKey(' 007 ')).toBe('007');
        expect(parseTournamentKey('1'.repeat(20))).toBe('1'.repeat(20));
    });

    it('rejects empty junk, non-digits, and oversized keys with 400', () => {
        for (const junk of ['', '   ', 'abc', '12ab', '12-34', '12.3', '-1', '1'.repeat(21)]) {
            try {
                parseTournamentKey(junk);
                expect.unreachable(`expected 400 for ${JSON.stringify(junk)}`);
            } catch (err) {
                expect(err.status).toBe(400);
            }
        }
    });

    it('required: missing/empty → 400 (not 500)', () => {
        try { parseTournamentKey(null, { required: true }); expect.unreachable(); }
        catch (err) { expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/required/i) }); }
        try { parseTournamentKey('', { required: true }); expect.unreachable(); }
        catch (err) { expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/required/i) }); }
    });
});

describe('rateLimit', () => {
    let env;
    let cache;
    beforeEach(() => {
        env = mockEnv();
        cache = installMockCaches();
    });
    afterEach(() => { delete globalThis.caches; });

    it('uses Cache API https://rl.internal/${bucket}/${ip} and allows exactly max ticks in the window', async () => {
        const r = req('https://example.test/api/hub', '203.0.113.9');
        for (let i = 0; i < RL_PER_MINUTE.max; i++) {
            await rateLimit(env, r, 'hub');
        }
        expect(await cacheCount(cache, 'hub', '203.0.113.9')).toBe(RL_PER_MINUTE.max);
        await expectReject(rateLimit(env, r, 'hub'), 429, /too many requests/i);
        expect(await cacheCount(cache, 'hub', '203.0.113.9')).toBe(RL_PER_MINUTE.max + 1);
        expect([...env.TENNIS_CACHE._store.keys()]).toEqual([]);
    });

    it('isolates buckets and IPs (hub vs livescore, local fallback)', async () => {
        const a = req('https://example.test/api/hub', '198.51.100.1');
        const b = req('https://example.test/api/livescore', '198.51.100.1');
        const c = req('https://example.test/api/hub'); // no CF-Connecting-IP → local
        await rateLimit(env, a, 'hub');
        await rateLimit(env, b, 'livescore');
        await rateLimit(env, c, 'hub');
        expect([...cache._store.keys()].sort()).toEqual([
            rateLimitCacheUrl('hub', '198.51.100.1'),
            rateLimitCacheUrl('hub', 'local'),
            rateLimitCacheUrl('livescore', '198.51.100.1'),
        ]);
        expect([...env.TENNIS_CACHE._store.keys()]).toEqual([]);
    });

    it('resets the counter when the stored window has elapsed', async () => {
        const r = req('https://example.test/api/hub', '203.0.113.9');
        await cache.put(rateLimitCacheUrl('hub', '203.0.113.9'), new Response(
            JSON.stringify({ count: RL_PER_MINUTE.max, windowStart: Date.now() - 61_000 }),
            { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } },
        ));
        await rateLimit(env, r, 'hub');
        expect(await cacheCount(cache, 'hub', '203.0.113.9')).toBe(1);
    });

    it('fails closed with 429 when Cache API is missing or match/put throws', async () => {
        const r = req();
        delete globalThis.caches;
        await expectReject(rateLimit({}, r, 'livescore'), 429, /too many requests/i);
        globalThis.caches = {
            default: {
                async match() { throw new Error('cache down'); },
                async put() {},
            },
        };
        await expectReject(rateLimit({}, r, 'livescore'), 429, /too many requests/i);
    });

    it('fails closed with 429 when the stored counter is corrupt', async () => {
        const r = req('https://example.test/api/hub', '203.0.113.9');
        await cache.put(rateLimitCacheUrl('hub', '203.0.113.9'), new Response(
            JSON.stringify({ count: 'NaN', windowStart: 'nope' }),
            { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } },
        ));
        await expectReject(rateLimit(env, r, 'hub'), 429, /too many requests/i);
    });
});
