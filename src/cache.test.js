import { describe, it, expect, vi, afterEach } from 'vitest';
import { cache } from './cache.js';
import { TTL } from './config.js';

function kvEnv({ put } = {}) {
    const store = new Map();
    return {
        store,
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
                if (put) return put(key, value);
                store.set(key, value);
            },
            async delete(key) {
                store.delete(key);
            },
            async list({ prefix, cursor, limit = 1000 } = {}) {
                const keys = [...store.keys()]
                    .filter(k => !prefix || k.startsWith(prefix))
                    .sort();
                const start = cursor ? Number(cursor) : 0;
                const slice = keys.slice(start, start + limit);
                const next = start + slice.length;
                return {
                    keys: slice.map(name => ({ name })),
                    list_complete: next >= keys.length,
                    cursor: next < keys.length ? String(next) : undefined,
                };
            },
        },
    };
}

describe('TTL.livescore', () => {
    it('is 30 seconds so live polls are not stuck behind a 5-minute floor', () => {
        expect(TTL.livescore).toBe(30);
        expect(TTL.livescore).toBeGreaterThanOrEqual(30);
        expect(TTL.livescore).toBeLessThanOrEqual(60);
        expect(TTL.livescoreIdle).toBe(120);
        expect(TTL.livescoreSeen).toBe(12 * 60 * 60);
        expect(TTL.hub).toBe(5 * 60);
        expect(TTL.drawsLive).toBe(5 * 60);
        expect(TTL.fixtures).toBe(24 * 60 * 60);
        expect(TTL.standings).toBe(48 * 60 * 60);
        expect(TTL.tournaments).toBe(48 * 60 * 60);
        expect(TTL.players).toBe(72 * 60 * 60);
        expect(TTL.h2h).toBe(48 * 60 * 60);
    });
});

describe('cache.set fail-soft', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('does not throw when KV put exceeds the daily write quota', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const env = kvEnv({
            put: async () => { throw new Error('KV put() limit exceeded for the day.'); },
        });
        await expect(cache.set(env, TTL.livescore, { ok: true }, 'livescore2', 'ATP', 'all'))
            .resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it('still returns after a transient KV failure so callers can serve fresh data', async () => {
        const env = kvEnv({
            put: async () => { throw new Error('KV put() failed: network'); },
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await cache.set(env, 30, [{ matchKey: '1' }], 'hub3', 'ATP');
        expect(await cache.get(env, 'hub3', 'ATP')).toBeNull();
    });

    it('writes the primary key and :stale backup by default', async () => {
        const env = kvEnv();
        await cache.set(env, 300, { x: 1 }, 'hub3', 'ATP');
        expect([...env.store.keys()].sort()).toEqual([
            'tw:hub3:ATP',
            'tw:hub3:ATP:stale',
        ]);
    });

    it('skips the :stale KV write when skipStale is set', async () => {
        const env = kvEnv();
        await cache.set(env, TTL.livescore, [{ isLive: true }], 'livescore2', 'ATP', 'all', {
            skipStale: true,
        });
        expect([...env.store.keys()]).toEqual(['tw:livescore2:ATP:all']);
        expect(env.store.has('tw:livescore2:ATP:all:stale')).toBe(false);
    });

    it('setEdge does not throw when Cache API put fails', async () => {
        globalThis.caches = {
            default: {
                async match() { return undefined; },
                async put() { throw new Error('Cache API put failed'); },
            },
        };
        const env = kvEnv();
        await expect(cache.setEdge(30, [{ matchKey: '1' }], 'livescore3', 'ATP', 'all'))
            .resolves.toBeUndefined();
        expect([...env.store.keys()]).toEqual([]);
        delete globalThis.caches;
    });

    it('setEdge writes Cache API only and does not touch KV', async () => {
        const store = new Map();
        globalThis.caches = {
            default: {
                async match(req) {
                    const url = typeof req === 'string' ? req : req.url;
                    const entry = store.get(url);
                    if (!entry) return undefined;
                    return new Response(entry.body, { status: 200, headers: entry.headers });
                },
                async put(req, response) {
                    const url = typeof req === 'string' ? req : req.url;
                    const headers = {};
                    response.headers.forEach((v, k) => { headers[k] = v; });
                    store.set(url, { body: await response.clone().text(), headers });
                },
            },
        };
        const env = kvEnv();
        await cache.setEdge(3600, [{ matchKey: '1' }], 'livescore3', 'ATP', 'all', 'seen');
        expect([...env.store.keys()]).toEqual([]);
        const hit = await cache.get(env, 'livescore3', 'ATP', 'all', 'seen');
        expect(hit.data).toEqual([{ matchKey: '1' }]);
        delete globalThis.caches;
    });
});

describe('cache.invalidatePrefix', () => {
    afterEach(() => { delete globalThis.caches; });

    it('deletes KV primary and :stale keys under the prefix, not siblings', async () => {
        const env = kvEnv();
        await cache.set(env, 300, { n: 10 }, 'h2h-v11', 'ATP', '47275', '68074');
        await cache.set(env, 300, { n: 17 }, 'h2h-v11', 'ATP', '68074', '47275');
        await cache.set(env, 300, { n: 1 }, 'h2h-v11', 'ATP', '472750', '1');

        await cache.invalidatePrefix(env, 'h2h-v11', 'ATP', '47275');

        expect(await cache.get(env, 'h2h-v11', 'ATP', '47275', '68074')).toBeNull();
        expect(await cache.getStale(env, 'h2h-v11', 'ATP', '47275', '68074')).toBeNull();
        expect((await cache.get(env, 'h2h-v11', 'ATP', '68074', '47275')).data).toEqual({ n: 17 });
        expect((await cache.get(env, 'h2h-v11', 'ATP', '472750', '1')).data).toEqual({ n: 1 });
    });

    it('is a no-op when KV list is unavailable', async () => {
        const env = kvEnv();
        await cache.set(env, 300, { n: 10 }, 'h2h-v11', 'ATP', '47275', '68074');
        delete env.TENNIS_CACHE.list;
        await expect(cache.invalidatePrefix(env, 'h2h-v11', 'ATP', '47275')).resolves.toBeUndefined();
        expect((await cache.get(env, 'h2h-v11', 'ATP', '47275', '68074')).data).toEqual({ n: 10 });
    });
});
