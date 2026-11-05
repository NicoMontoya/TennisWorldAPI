import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { apiTennis } from './apiClient.js';
import { createMemoryD1 } from './d1Memory.js';
import { rememberApiTennisList, rememberFixtures } from './d1Store.js';
import {
    API_TENNIS_FLAG_KEY,
    apiTennisHardStopMode,
    resetApiTennisStopStateForTests,
} from './apiTennisStop.js';
import { QUOTA_FLAG_KEY, resetQuotaStopStateForTests } from './quotaStop.js';

function urlOf(req) {
    return typeof req === 'string' ? req : req.url;
}

function installCaches() {
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
            async delete(req) { store.delete(urlOf(req)); },
            _store: store,
        },
    };
}

function cacheEnv(extra = {}) {
    const store = new Map();
    return {
        CORS_ORIGIN: '*',
        TENNIS_API_KEY: 'super-secret-tennis-key',
        RAPIDAPI_KEY: 'super-secret-rapid-key',
        DEMO_MODE: 'false',
        DB: createMemoryD1(),
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
        ...extra,
    };
}

function installFetch(handler) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
        calls.push(String(url));
        return handler(String(url), init);
    });
    return calls;
}

describe('API-Tennis hard stop', () => {
    beforeEach(() => {
        resetApiTennisStopStateForTests();
        resetQuotaStopStateForTests();
        installCaches();
    });
    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    it('defaults to on and treats only the exact off/force strings as those modes', () => {
        expect(apiTennisHardStopMode(undefined)).toBe('on');
        expect(apiTennisHardStopMode({})).toBe('on');
        expect(apiTennisHardStopMode({ API_TENNIS_HARD_STOP: 'on' })).toBe('on');
        expect(apiTennisHardStopMode({ API_TENNIS_HARD_STOP: 'off' })).toBe('off');
        expect(apiTennisHardStopMode({ API_TENNIS_HARD_STOP: 'force' })).toBe('force');
        expect(apiTennisHardStopMode({ API_TENNIS_HARD_STOP: 'ON ' })).toBe('on');
        expect(apiTennisHardStopMode({ API_TENNIS_HARD_STOP: '' })).toBe('on');
    });

    it('force on either provider skips the outbound fetch and serves the last D1 copy with asOf', async () => {
        const rapidEnv = cacheEnv({ RAPIDAPI_HARD_STOP: 'force', API_TENNIS_HARD_STOP: 'off' });
        await rememberFixtures(rapidEnv, 'ATP', [{
            matchKey: '88001',
            tournamentKey: '16745',
            tournamentName: 'Metz',
            date: '2099-05-01',
            time: '14:30',
            status: 'Not Started',
            round: 'Final',
            player1Name: 'J. Sinner',
            player2Name: 'C. Alcaraz',
        }]);
        const rapidCalls = installFetch(() => {
            throw new Error('fetch must not be called');
        });
        const rapidRes = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), rapidEnv);
        const rapidBody = await rapidRes.json();
        expect(rapidCalls).toHaveLength(0);
        expect(rapidRes.status).toBe(200);
        expect(rapidBody.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(rapidBody.data[0]).toMatchObject({ matchKey: '88001', tournamentName: 'Metz' });
        expect(JSON.stringify(rapidBody)).not.toContain('super-secret-rapid-key');

        const tennisEnv = cacheEnv({ API_TENNIS_HARD_STOP: 'force', RAPIDAPI_HARD_STOP: 'off' });
        await rememberApiTennisList(tennisEnv, 'tournaments', 'ATP', [{
            tournamentKey: '2004',
            name: 'Madrid',
            surface: 'Clay',
        }]);
        const tennisCalls = installFetch(() => {
            throw new Error('fetch must not be called');
        });
        const tennisRes = await worker.fetch(new Request('https://example.test/api/tournaments?tour=ATP'), tennisEnv);
        const tennisBody = await tennisRes.json();
        expect(tennisCalls).toHaveLength(0);
        expect(tennisRes.status).toBe(200);
        expect(tennisBody.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(tennisBody.data).toEqual([expect.objectContaining({ tournamentKey: '2004', name: 'Madrid' })]);
        expect(JSON.stringify(tennisBody)).not.toContain('super-secret-tennis-key');
    });

    it('trips the API-Tennis stop on a 429 and does not call again', async () => {
        const env = cacheEnv({ API_TENNIS_DAILY_CAP: '50' });
        await rememberApiTennisList(env, 'tournaments', 'ATP', [{
            tournamentKey: '9',
            name: 'Stored Open',
        }]);
        const calls = installFetch(() => new Response('slow down', { status: 429 }));

        const first = await worker.fetch(new Request('https://example.test/api/tournaments?tour=ATP'), env);
        const firstBody = await first.json();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('api.api-tennis.com');
        expect(calls[0]).not.toContain('rapidapi');
        expect(first.status).toBe(200);
        expect(firstBody.data[0].name).toBe('Stored Open');
        expect(firstBody.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(env.TENNIS_CACHE._store.has(API_TENNIS_FLAG_KEY)).toBe(true);
        expect(env.TENNIS_CACHE._store.has(QUOTA_FLAG_KEY)).toBe(false);
        expect(JSON.stringify(firstBody)).not.toContain('super-secret-tennis-key');

        const second = await worker.fetch(new Request('https://example.test/api/tournaments?tour=ATP'), env);
        const secondBody = await second.json();
        expect(calls).toHaveLength(1);
        expect(second.status).toBe(200);
        expect(secondBody.asOf).toBeTruthy();
        expect(secondBody.data[0].tournamentKey).toBe('9');
    });

    it('caps API-Tennis calls per UTC day', async () => {
        const env = cacheEnv({ API_TENNIS_HARD_STOP: 'on', API_TENNIS_DAILY_CAP: '1' });
        const calls = installFetch(() => new Response(JSON.stringify({ result: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await apiTennis.tournaments(env, '1');
        expect(calls).toHaveLength(1);
        await expect(apiTennis.tournaments(env, '1')).rejects.toMatchObject({
            name: 'QuotaStopError',
            message: 'Upstream request failed',
        });
        expect(calls).toHaveLength(1);
    });

    it('does not retry a 429 when the API-Tennis stop is off', async () => {
        const env = cacheEnv({ API_TENNIS_HARD_STOP: 'off' });
        const calls = installFetch(() => new Response('slow down', { status: 429 }));
        await expect(apiTennis.standings(env, '1')).rejects.toThrow('Upstream request failed');
        await expect(apiTennis.standings(env, '1')).rejects.toThrow('Upstream request failed');
        expect(calls).toHaveLength(2);
        expect(env.TENNIS_CACHE._store.has(API_TENNIS_FLAG_KEY)).toBe(false);
    });
});
