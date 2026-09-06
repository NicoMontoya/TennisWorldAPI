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
        },
    };
}

describe('TTL.livescore', () => {
    it('is 30 seconds so live polls are not stuck behind a 5-minute floor', () => {
        expect(TTL.livescore).toBe(30);
        expect(TTL.livescore).toBeGreaterThanOrEqual(30);
        expect(TTL.livescore).toBeLessThanOrEqual(60);
        expect(TTL.livescoreIdle).toBe(120);
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
});
