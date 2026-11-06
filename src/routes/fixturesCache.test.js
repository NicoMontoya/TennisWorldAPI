import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { createMemoryD1 } from '../d1Memory.js';
import { rememberFixtures } from '../d1Store.js';
import { resetQuotaStopStateForTests } from '../quotaStop.js';
import { TTL } from '../config.js';

const RAPID_KEY = 'super-secret-rapid-key';
const BOARD = 'https://example.test/api/fixtures?tour=ATP&tournamentKey=21362';
const START = new Date('2026-11-05T12:00:00.000Z');

function expiringKv() {
    const store = new Map();
    const puts = [];
    return {
        puts,
        async get(key, type) {
            const entry = store.get(key);
            if (!entry) return null;
            if (entry.expiresAt != null && Date.now() >= entry.expiresAt) {
                store.delete(key);
                return null;
            }
            const raw = entry.value;
            if (type === 'json' || type?.type === 'json') {
                try { return JSON.parse(raw); } catch { return raw; }
            }
            return raw;
        },
        async put(key, value, opts) {
            puts.push({ key, opts });
            const ttl = opts?.expirationTtl;
            store.set(key, {
                value,
                expiresAt: Number.isFinite(ttl) ? Date.now() + ttl * 1000 : null,
            });
        },
        async delete(key) {
            store.delete(key);
        },
    };
}

function cacheEnv(extra = {}) {
    return {
        CORS_ORIGIN: '*',
        RAPIDAPI_KEY: RAPID_KEY,
        DEMO_MODE: 'false',
        RAPIDAPI_HARD_STOP: 'on',
        RAPIDAPI_DAILY_CALL_CAP: '20',
        D1_DAILY_WRITE_BUDGET: '20000',
        DB: createMemoryD1(),
        TENNIS_CACHE: expiringKv(),
        ...extra,
    };
}

function installFetch(body) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        calls.push({ url: String(url) });
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'x-ratelimit-requests-remaining': '100',
            },
        });
    });
    return calls;
}

async function getBoard(env) {
    const res = await worker.fetch(new Request(BOARD), env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    return body;
}

function rapidTally(env) {
    return (env.DB._tables.call_tally || []).filter(row => row.provider === 'rapidapi');
}

describe('fixtures empty cache', () => {
    beforeEach(() => {
        resetQuotaStopStateForTests();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.fetch;
        delete globalThis.caches;
        vi.restoreAllMocks();
    });

    it('caches an empty board for 60s and still claims each retry under the daily cap', async () => {
        const env = cacheEnv();
        // Stuck 24h empty entry under the previous prefix must be ignored.
        await env.TENNIS_CACHE.put(
            'tw:fixtures3:ATP:21362::',
            JSON.stringify({ data: [], cachedAt: START.toISOString(), stale: false }),
        );
        env.TENNIS_CACHE.puts.length = 0;
        const calls = installFetch({ data: [] });

        for (let i = 0; i < 100; i++) {
            const body = await getBoard(env);
            expect(body.data).toEqual([]);
        }
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toContain('/atp/fixtures/tournament/21362');
        expect(rapidTally(env)).toEqual([
            expect.objectContaining({ utc_day: '2026-11-05', count: 1 }),
        ]);

        vi.setSystemTime(new Date(START.getTime() + 59_000));
        expect((await getBoard(env)).data).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(rapidTally(env)[0].count).toBe(1);

        vi.setSystemTime(new Date(START.getTime() + 60_000));
        for (let i = 0; i < 100; i++) {
            expect((await getBoard(env)).data).toEqual([]);
        }
        expect(calls).toHaveLength(2);
        expect(rapidTally(env)[0].count).toBe(2);

        const fresh = env.TENNIS_CACHE.puts.filter(put => put.key.startsWith('tw:fixtures4:'));
        expect(fresh.length).toBeGreaterThan(0);
        expect(fresh.every(put => put.opts?.expirationTtl === TTL.fixturesEmpty)).toBe(true);
        expect(fresh.every(put => put.opts?.expirationTtl === 60)).toBe(true);
        expect(env.TENNIS_CACHE.puts.some(put => String(put.key).includes('fixtures3'))).toBe(false);
        expect(env.TENNIS_CACHE.puts.some(put => String(put.key).endsWith(':stale'))).toBe(false);
    });

    it('serves D1 last-good when upstream is empty and does not overwrite those rows', async () => {
        const env = cacheEnv();
        await rememberFixtures(env, 'ATP', [{
            matchKey: '42',
            tournamentKey: '21362',
            tournamentName: 'Paris',
            date: '2026-11-06',
            time: '11:00',
            status: 'Not Started',
            round: 'Final',
            player1Name: 'Ada',
            player2Name: 'Bea',
        }]);
        const calls = installFetch({ data: [] });

        const first = await getBoard(env);
        const second = await getBoard(env);
        expect(first.data).toEqual([expect.objectContaining({ matchKey: '42', tournamentName: 'Paris' })]);
        expect(second.data).toEqual(first.data);
        expect(first.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(calls).toHaveLength(1);
        expect(rapidTally(env)[0].count).toBe(1);
        expect(env.DB._tables.fixtures).toHaveLength(1);
        expect(env.DB._tables.fixtures[0].match_key).toBe('42');
        expect(JSON.parse(env.DB._tables.fixtures[0].payload).player1Name).toBe('Ada');
    });

    it('does not spend a second upstream call when the daily cap is already used', async () => {
        const env = cacheEnv({ RAPIDAPI_DAILY_CALL_CAP: '1' });
        const calls = installFetch({ data: [] });
        expect((await getBoard(env)).data).toEqual([]);
        expect(calls).toHaveLength(1);

        vi.setSystemTime(new Date(START.getTime() + 60_000));
        expect((await getBoard(env)).data).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(rapidTally(env)[0].count).toBe(1);
    });

    it('keeps a non-empty board cached for 24h', async () => {
        const env = cacheEnv();
        const calls = installFetch({
            data: [{
                id: 88001,
                date: '2026-11-06T14:30:00.000Z',
                roundId: 9,
                tournament: { id: 21362, name: 'Paris' },
                player1Id: 1,
                player2Id: 2,
                player1: { id: 1, name: 'A. Player' },
                player2: { id: 2, name: 'B. Player' },
            }],
        });

        const first = await getBoard(env);
        expect(first.data).toEqual([expect.objectContaining({
            matchKey: '88001',
            tournamentKey: '21362',
            tournamentName: 'Paris',
        })]);
        expect(calls).toHaveLength(1);

        vi.setSystemTime(new Date(START.getTime() + 61_000));
        expect((await getBoard(env)).data[0].matchKey).toBe('88001');
        expect(calls).toHaveLength(1);

        vi.setSystemTime(new Date(START.getTime() + TTL.fixtures * 1000 - 1000));
        expect((await getBoard(env)).data[0].matchKey).toBe('88001');
        expect(calls).toHaveLength(1);
        expect(rapidTally(env)[0].count).toBe(1);

        vi.setSystemTime(new Date(START.getTime() + TTL.fixtures * 1000));
        expect((await getBoard(env)).data[0].matchKey).toBe('88001');
        expect(calls).toHaveLength(2);

        const primary = env.TENNIS_CACHE.puts.filter(put => put.key === 'tw:fixtures4:ATP:21362::');
        expect(primary.length).toBeGreaterThan(0);
        expect(primary.every(put => put.opts?.expirationTtl === TTL.fixtures)).toBe(true);
        expect(primary.every(put => put.opts?.expirationTtl === 24 * 60 * 60)).toBe(true);
    });
});
