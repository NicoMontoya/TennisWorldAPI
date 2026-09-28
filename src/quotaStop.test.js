import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rapidAPI } from './apiClient.js';
import { handleLivescore } from './routes/livescore.js';
import { handleHub } from './routes/hub.js';
import { handleDraws } from './routes/draws.js';
import { handlePlayerStats } from './routes/playerStats.js';
import { handlePlayerHistory } from './routes/playerHistory.js';
import { handleScheduled } from './index.js';
import worker from './index.js';
import {
    QUOTA_FLAG_KEY,
    QUOTA_HEADER_MISS_THRESHOLD,
    QUOTA_RESET_DEFAULT_SEC,
    QUOTA_RESET_MAX_SEC,
    QUOTA_RESET_MIN_SEC,
    QuotaStopError,
    clampQuotaReset,
    hardStopMode,
    resetQuotaStopStateForTests,
} from './quotaStop.js';

const DUMMY_KEY = 'dummy-rapidapi-key';
const LEAK = /quota|ratelimit|requests-remaining|requests-reset|hard stop|-6004|tw:quota/i;

function mockEnv(mode) {
    const store = new Map();
    const puts = [];
    const env = {
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
            async put(key, value, opts) {
                puts.push({ key, value, opts });
                store.set(key, value);
            },
            async delete(key) {
                store.delete(key);
            },
            _store: store,
        },
        _puts: puts,
    };
    if (mode !== undefined) env.RAPIDAPI_HARD_STOP = mode;
    return env;
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
            async delete(req) {
                store.delete(urlOf(req));
            },
            _store: store,
        },
    };
    return store;
}

function installFetch(handler) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers || {} });
        return handler(String(url), init);
    });
    return calls;
}

function jsonRes(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers });
}

function rankingsFetch(remaining, reset) {
    return installFetch(() => {
        const headers = {};
        if (remaining !== undefined) headers['x-ratelimit-requests-remaining'] = String(remaining);
        if (reset !== undefined) headers['x-ratelimit-requests-reset'] = String(reset);
        return jsonRes({ data: [{ position: 1, player: { id: 1, name: 'A' } }] }, 200, headers);
    });
}

function flagPuts(env) {
    return env._puts.filter(p => p.key === QUOTA_FLAG_KEY);
}

function getReq(path) {
    return new Request(`https://example.test${path}`, {
        headers: { 'CF-Connecting-IP': '203.0.113.50' },
    });
}

async function putJson(env, key, value) {
    await env.TENNIS_CACHE.put(key, JSON.stringify(value));
}

describe('RapidAPI quota hard stop', () => {
    let logs;

    beforeEach(() => {
        resetQuotaStopStateForTests();
        installMockCaches();
        logs = [];
        vi.spyOn(console, 'warn').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
        vi.spyOn(console, 'error').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
        vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    });

    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    function assertLogsClean() {
        const text = logs.join('\n');
        expect(text).not.toMatch(/tw:quota:stop|x-ratelimit|-6004/i);
    }

    it('does not fetch when the shared flag is active', async () => {
        const env = mockEnv('on');
        const until = Date.now() + 60 * 60 * 1000;
        await putJson(env, QUOTA_FLAG_KEY, { until });
        await putJson(env, 'tw:standings2:ATP:stale', {
            data: [{ rank: 1, playerKey: '1', name: 'Cached', rankingDate: '2026-09-21' }],
            stale: true,
        });
        await putJson(env, 'tw:standings2:WTA:stale', {
            data: [{ rank: 1, playerKey: '2', name: 'Cached', rankingDate: '2026-09-21' }],
            stale: true,
        });
        await putJson(env, 'tw:hub3:ATP:stale', {
            data: { tournament: { name: 'Cached Hub' }, featuredMatch: null, h2h: null },
            stale: true,
        });
        await putJson(env, 'tw:draws14:20340:ATP:stale', {
            data: { tournamentKey: '20340', name: 'Cached Draw', rounds: [] },
            stale: true,
        });

        const calls = installFetch(() => {
            throw new Error('fetch must not be called');
        });

        const live = await handleLivescore(getReq('/api/livescore?tour=ATP'), env);
        const hub = await handleHub(getReq('/api/hub?tour=ATP'), env);
        const draws = await handleDraws(getReq('/api/draws?tournamentKey=20340&tour=ATP'), env);
        const stats = await handlePlayerStats(getReq('/api/player-stats?tour=ATP&playerKey=47275'), env);
        const history = await handlePlayerHistory(getReq('/api/player-history?tour=ATP&playerKey=47275'), env);
        await handleScheduled(env, { scheduledTime: Date.UTC(2026, 8, 28, 0, 0, 0) });

        expect(calls).toHaveLength(0);
        expect(live).toEqual([]);
        expect(hub.tournament.name).toBe('Cached Hub');
        expect(draws.name).toBe('Cached Draw');
        expect(stats).toMatchObject({ titles: 0, form: [], wins: 0, losses: 0, birthday: null });
        expect(history).toEqual({ seasons: [], careerTitles: 0 });
        expect(logs.join('\n')).toMatch(/\[quota\] hard stop active/);
        expect(logs.join('\n')).toMatch(/standings:ATP:ok/);
        expect(logs.join('\n')).toMatch(/calendar:ATP:err:Upstream request failed/);
        expect(env.TENNIS_CACHE._store.has('tw:tournament-map-v6:ATP')).toBe(false);
        const dumped = JSON.stringify({ live, hub, draws, stats, history });
        expect(dumped).not.toMatch(LEAK);
        assertLogsClean();
    });

    it.each([
        ['-6004', '10', QUOTA_RESET_MIN_SEC],
        [undefined, '90', 90],
        ['abc', String(QUOTA_RESET_MAX_SEC + 5000), QUOTA_RESET_MAX_SEC],
        ['0', undefined, QUOTA_RESET_DEFAULT_SEC],
    ])('remaining %s trips the stop when the setting is on (reset ttl %s)', async (remaining, reset, ttl) => {
        const env = mockEnv('on');
        const calls = rankingsFetch(remaining, reset);

        const first = await rapidAPI.rankings(env, 'ATP', 5);
        expect(first.data).toHaveLength(1);
        expect(calls).toHaveLength(1);

        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toBeInstanceOf(QuotaStopError);
        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toMatchObject({
            name: 'QuotaStopError',
            status: 503,
            message: 'Upstream request failed',
        });
        expect(calls).toHaveLength(1);

        const puts = flagPuts(env);
        expect(puts).toHaveLength(1);
        expect(puts[0].opts.expirationTtl).toBe(ttl);
        const stored = JSON.parse(puts[0].value);
        expect(stored.until).toBeGreaterThan(Date.now());
        expect(stored.until).toBeLessThanOrEqual(Date.now() + ttl * 1000 + 2000);
        assertLogsClean();
    });

    it.each(['-6004', undefined, 'abc', '0'])(
        'remaining %s does not trip the stop when the setting is off',
        async (remaining) => {
            const env = mockEnv('off');
            const calls = rankingsFetch(remaining, '10');
            await rapidAPI.rankings(env, 'ATP', 5);
            await rapidAPI.rankings(env, 'ATP', 5);
            expect(calls).toHaveLength(2);
            expect(flagPuts(env)).toHaveLength(0);
            assertLogsClean();
        },
    );

    it.each([
        [undefined, 'off'],
        ['off', 'off'],
        ['on', 'on'],
        ['force', 'force'],
        ['', 'on'],
        ['ON ', 'on'],
        ['Off', 'on'],
        ['offf', 'on'],
    ])('RAPIDAPI_HARD_STOP %j -> %s', (value, expected) => {
        const env = value === undefined ? {} : { RAPIDAPI_HARD_STOP: value };
        expect(hardStopMode(env)).toBe(expected);
        expect(hardStopMode(undefined)).toBe('off');
    });

    it.each(['', 'ON ', 'Off', 'offf'])(
        '%j behaves as on: the first call fetches, the next one stops',
        async (value) => {
            const env = mockEnv(value);
            const calls = rankingsFetch('-6004', '3600');
            await rapidAPI.rankings(env, 'ATP', 5);
            expect(calls).toHaveLength(1);
            await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toBeInstanceOf(QuotaStopError);
            expect(calls).toHaveLength(1);
            expect(flagPuts(env)).toHaveLength(1);
        },
    );

    it('leaves the stop off when the setting is unset', async () => {
        const env = mockEnv();
        const calls = rankingsFetch('-6004', '10');
        await rapidAPI.rankings(env, 'ATP', 5);
        await rapidAPI.rankings(env, 'ATP', 5);
        expect(calls).toHaveLength(2);
        expect(flagPuts(env)).toHaveLength(0);
    });

    it('writes the shared flag once per trip, even across later requests', async () => {
        const env = mockEnv('on');
        const calls = rankingsFetch('-6004', '3600');

        await rapidAPI.rankings(env, 'ATP', 5);
        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toBeInstanceOf(QuotaStopError);
        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toBeInstanceOf(QuotaStopError);
        expect(flagPuts(env)).toHaveLength(1);
        expect(calls).toHaveLength(1);

        // A later request in a fresh isolate still sees the flag and does not write again.
        resetQuotaStopStateForTests();
        installMockCaches();
        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toBeInstanceOf(QuotaStopError);
        expect(flagPuts(env)).toHaveLength(1);
        expect(calls).toHaveLength(1);
    });

    it('clamps the reset to 60 seconds minimum and 31 days maximum', () => {
        expect(clampQuotaReset(null)).toBe(QUOTA_RESET_DEFAULT_SEC);
        expect(clampQuotaReset('')).toBe(QUOTA_RESET_DEFAULT_SEC);
        expect(clampQuotaReset('nope')).toBe(QUOTA_RESET_DEFAULT_SEC);
        expect(clampQuotaReset('10')).toBe(QUOTA_RESET_MIN_SEC);
        expect(clampQuotaReset(0)).toBe(QUOTA_RESET_MIN_SEC);
        expect(clampQuotaReset(-5)).toBe(QUOTA_RESET_MIN_SEC);
        expect(clampQuotaReset(90)).toBe(90);
        expect(clampQuotaReset(QUOTA_RESET_MAX_SEC + 1)).toBe(QUOTA_RESET_MAX_SEC);
        expect(QUOTA_RESET_MIN_SEC).toBe(60);
        expect(QUOTA_RESET_MAX_SEC).toBe(31 * 24 * 60 * 60);
        expect(QUOTA_RESET_DEFAULT_SEC).toBe(24 * 60 * 60);
    });

    it('skips the paid call when the flag read throws', async () => {
        const env = mockEnv('on');
        env.TENNIS_CACHE.get = async (key) => {
            if (key === QUOTA_FLAG_KEY) throw new Error('kv read failed');
            return null;
        };
        const calls = rankingsFetch('100', '3600');
        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toMatchObject({
            name: 'QuotaStopError',
            message: 'Upstream request failed',
        });
        expect(calls).toHaveLength(0);
        expect(flagPuts(env)).toHaveLength(0);
        assertLogsClean();
    });

    it('skips the paid call when the edge flag read throws', async () => {
        const env = mockEnv('on');
        globalThis.caches.default.match = async () => {
            throw new Error('edge read failed');
        };
        const calls = rankingsFetch('100', '3600');
        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toBeInstanceOf(QuotaStopError);
        expect(calls).toHaveLength(0);
    });

    it('force stops calls immediately', async () => {
        const env = mockEnv('force');
        const calls = rankingsFetch('5000', '3600');
        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toMatchObject({
            status: 503,
            message: 'Upstream request failed',
        });
        expect(calls).toHaveLength(0);
        expect(flagPuts(env)).toHaveLength(0);
        expect(logs.join('\n')).toMatch(/\[quota\] hard stop active/);
        assertLogsClean();
    });

    it('trips a local edge stop after consecutive missing remaining headers when KV will not take the flag', async () => {
        const env = mockEnv('on');
        env.TENNIS_CACHE.put = async (key, value, opts) => {
            env._puts.push({ key, value, opts });
            if (key === QUOTA_FLAG_KEY) throw new Error('kv put failed');
            env.TENNIS_CACHE._store.set(key, value);
        };
        const calls = rankingsFetch(undefined, undefined);
        const edge = globalThis.caches.default._store;

        for (let i = 0; i < QUOTA_HEADER_MISS_THRESHOLD; i++) {
            await rapidAPI.rankings(env, 'ATP', 5);
            edge.delete('https://quota.internal/stop');
        }
        expect(calls).toHaveLength(QUOTA_HEADER_MISS_THRESHOLD);

        await expect(rapidAPI.rankings(env, 'ATP', 5)).rejects.toBeInstanceOf(QuotaStopError);
        expect(calls).toHaveLength(QUOTA_HEADER_MISS_THRESHOLD);
        // The shared put is attempted once and rejected; the latch does not retry it.
        expect(flagPuts(env)).toHaveLength(1);
        expect(env.TENNIS_CACHE._store.has(QUOTA_FLAG_KEY)).toBe(false);
    });

    it('responses contain no quota info', async () => {
        const env = mockEnv('on');
        const until = Date.now() + 60 * 60 * 1000;
        await putJson(env, QUOTA_FLAG_KEY, { until });

        const calls = installFetch(() => jsonRes(
            { data: [] },
            200,
            {
                'x-ratelimit-requests-remaining': '-6004',
                'x-ratelimit-requests-reset': '999999',
            },
        ));

        const paths = [
            '/api/livescore?tour=ATP',
            '/api/player-stats?tour=ATP&playerKey=47275',
            '/api/player-history?tour=ATP&playerKey=47275',
            '/api/hub?tour=ATP',
            '/api/draws?tournamentKey=20340&tour=ATP',
        ];

        for (const path of paths) {
            const res = await worker.fetch(getReq(path), env);
            const text = await res.text();
            expect(text).not.toMatch(LEAK);
            expect(text).not.toContain(DUMMY_KEY);
            for (const [k, v] of res.headers) {
                expect(`${k}: ${v}`).not.toMatch(LEAK);
            }
            const body = JSON.parse(text);
            if (path.includes('/hub') || path.includes('/draws')) {
                expect(res.status).toBe(503);
                expect(body).toEqual({ ok: false, error: 'Upstream request failed' });
            } else {
                expect(res.status).toBe(200);
                expect(body.ok).toBe(true);
            }
        }
        expect(calls).toHaveLength(0);

        // The call that discovers exhaustion still must not copy upstream quota headers out.
        // Fresh edge cache so the flag mirrored above does not block this call.
        resetQuotaStopStateForTests();
        installMockCaches();
        const open = mockEnv('on');
        const discovered = rankingsFetch('-6004', '86400');
        const liveRes = await worker.fetch(getReq('/api/livescore?tour=ATP'), open);
        const liveText = await liveRes.text();
        expect(liveRes.status).toBe(200);
        expect(liveText).not.toMatch(LEAK);
        for (const [k, v] of liveRes.headers) {
            expect(`${k}: ${v}`).not.toMatch(LEAK);
        }
        expect(discovered.length).toBeGreaterThan(0);
        expect(flagPuts(open)).toHaveLength(1);
        assertLogsClean();
    });
});
