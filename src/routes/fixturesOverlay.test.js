import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { createMemoryD1 } from '../d1Memory.js';
import { rememberFixtures } from '../d1Store.js';
import { resetQuotaStopStateForTests } from '../quotaStop.js';
import { normalizeFixturesFeed } from '../transforms/fixturesFeed.js';
import { resetFixtureStatusMemoryForTests } from './fixtures.js';

const { livescoreCalls } = vi.hoisted(() => ({ livescoreCalls: [] }));

vi.mock('./livescore.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        handleLivescore: async (...args) => {
            livescoreCalls.push(args);
            return actual.handleLivescore(...args);
        },
    };
});

const BOARD = 'https://example.test/api/fixtures?tour=ATP&tournamentKey=21362';
const QUOTA_STOP_KEY = 'tw:quota:stop:v1';

function expiringKv() {
    const store = new Map();
    const puts = [];
    return {
        puts,
        async get(key, type) {
            const entry = store.get(key);
            if (!entry) return null;
            const raw = entry.value;
            if (type === 'json' || type?.type === 'json') {
                try { return JSON.parse(raw); } catch { return raw; }
            }
            return raw;
        },
        async put(key, value, opts) {
            puts.push({ key, opts });
            store.set(key, { value });
        },
        async delete(key) {
            store.delete(key);
        },
        _store: store,
    };
}

function cacheEnv() {
    return {
        CORS_ORIGIN: '*',
        RAPIDAPI_KEY: 'super-secret-rapid-key',
        DEMO_MODE: 'false',
        RAPIDAPI_HARD_STOP: 'on',
        RAPIDAPI_DAILY_CALL_CAP: '20',
        D1_DAILY_WRITE_BUDGET: '20000',
        DB: createMemoryD1(),
        TENNIS_CACHE: expiringKv(),
    };
}

function installFetch(body) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        calls.push(String(url));
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

function extraUpstream(calls) {
    return calls.filter(url => /events\/live|tournament\/results/i.test(url));
}

async function seedLivescore(env, data, cachedAt = '2026-11-16T11:49:00.000Z') {
    await env.TENNIS_CACHE.put('tw:livescore3:ATP:all', JSON.stringify({
        data,
        cachedAt,
        fetchedAt: cachedAt,
        stale: false,
    }));
}

const timedRow = {
    id: 88001,
    date: '2026-11-06T14:30:00.000Z',
    roundId: 9,
    tournament: { id: 21362, name: 'Paris' },
    player1Id: 2072,
    player2Id: 2315,
    player1: { id: 2072, name: 'J. Sinner' },
    player2: { id: 2315, name: 'C. Alcaraz' },
};

describe('fixture overlay security', () => {
    beforeEach(() => {
        resetQuotaStopStateForTests();
        resetFixtureStatusMemoryForTests();
        livescoreCalls.length = 0;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        delete globalThis.fetch;
        delete globalThis.caches;
        vi.restoreAllMocks();
    });

    it('empty cache adds zero RapidAPI calls', async () => {
        const env = cacheEnv();
        const calls = installFetch({ data: [timedRow], hasNextPage: false });

        const first = await worker.fetch(new Request(BOARD), env);
        const body = await first.json();
        expect(first.status).toBe(200);
        expect(first.headers.get('Cache-Control')).toBeNull();
        expect(body.ok).toBe(true);
        expect(body.asOf).toBeUndefined();
        expect(body.data).toHaveLength(1);
        expect(body.data[0].statusAsOf).toBe('');
        expect(body.data[0].status).toBe('Not Started');

        const { statusAsOf, ...rest } = body.data[0];
        expect(statusAsOf).toBe('');
        expect(rest).toEqual(normalizeFixturesFeed({ data: [timedRow] }, { tour: 'ATP' })[0]);

        const second = await worker.fetch(new Request(BOARD), env);
        const again = await second.json();
        expect(second.headers.get('Cache-Control')).toBeNull();
        expect(again.data).toEqual(body.data);

        expect(extraUpstream(calls)).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('/atp/fixtures/tournament/21362');
        expect(livescoreCalls).toHaveLength(0);
        expect(env.TENNIS_CACHE.puts.some(put => put.key === QUOTA_STOP_KEY)).toBe(false);
    });

    it('Live never snaps back to Not Started', async () => {
        const env = cacheEnv();
        const nowMs = Date.now();
        const startTimestamp = Math.floor(nowMs / 1000);
        const calls = installFetch({
            data: [{ ...timedRow, date: '2026-11-16' }],
            hasNextPage: false,
        });
        await seedLivescore(env, [{
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Live',
            statusText: 'InPlay',
            isLive: true,
            setScores: ['6-4', '3-2'],
            currentGame: '30 - 15',
            startTimestamp,
            session: 'session-SENTINEL',
            memberId: 'member-SENTINEL',
        }]);

        const first = await worker.fetch(new Request(BOARD), env);
        const live = await first.json();
        expect(live.data[0]).toMatchObject({
            status: 'Live',
            isLive: true,
            setScores: ['6-4', '3-2'],
            currentGame: '30 - 15',
            winner: '',
            startsAtUtc: new Date(startTimestamp * 1000).toISOString(),
            statusAsOf: '2026-11-16T11:49:00.000Z',
        });
        expect(JSON.stringify(live)).not.toContain('SENTINEL');

        await seedLivescore(env, [{
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Not Started',
            isLive: false,
            setScores: [],
            startTimestamp: startTimestamp + 20 * 24 * 60 * 60,
        }], '2026-11-16T12:05:00.000Z');

        const second = await worker.fetch(new Request(BOARD), env);
        const stuck = await second.json();
        expect(stuck.data[0].status).toBe('Live');
        expect(stuck.data[0].isLive).toBe(true);
        expect(stuck.data[0].setScores).toEqual(['6-4', '3-2']);
        expect(stuck.data[0].startsAtUtc).toBe(live.data[0].startsAtUtc);
        expect(stuck.data[0].status).not.toBe('Not Started');
        expect(extraUpstream(calls)).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(livescoreCalls).toHaveLength(0);
    });

    it('fixtures response has no session or member fields', async () => {
        const env = cacheEnv();
        installFetch({ data: [timedRow], hasNextPage: false });
        await seedLivescore(env, [{
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Live',
            isLive: true,
            setScores: ['4-4'],
            session: 'session-SENTINEL',
            sessionId: 'sid-SENTINEL',
            member: { id: 'member-SENTINEL' },
            memberId: 'member-SENTINEL',
            email: 'member@example.test',
            authorization: 'Bearer secret-SENTINEL',
            cookie: 'tw_session=SENTINEL',
            userId: 'user-SENTINEL',
            token: 'token-SENTINEL',
        }]);
        await env.TENNIS_CACHE.put('tw:draws14:21362:ATP', JSON.stringify({
            data: {
                rounds: [{
                    matches: [{
                        matchKey: '777',
                        player1Key: '2072',
                        player2Key: '2315',
                        tournamentKey: '21362',
                        roundId: 9,
                        status: 'Not Started',
                        session: 'draw-session-SENTINEL',
                        memberId: 'draw-member-SENTINEL',
                    }],
                }],
            },
            cachedAt: '2026-11-16T11:40:00.000Z',
        }));

        const res = await worker.fetch(new Request(BOARD), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBeNull();
        const banned = [
            'session', 'sessionId', 'sessionToken', 'member', 'memberId',
            'email', 'userId', 'token', 'authorization', 'cookie', 'password',
        ];
        expect(body.data).toHaveLength(1);
        for (const key of banned) expect(body.data[0]).not.toHaveProperty(key);
        for (const key of Object.keys(body)) expect(banned).not.toContain(key);
        const text = JSON.stringify(body);
        expect(text).not.toContain('SENTINEL');
        expect(text).not.toContain('member@example.test');
        expect(text).not.toContain('Bearer');
        expect(body.data[0].status).toBe('Live');
        expect(body.data[0].player1Name).toBe('J. Sinner');
    });
});

describe('fixture overlay on /api/fixtures', () => {
    beforeEach(() => {
        resetQuotaStopStateForTests();
        resetFixtureStatusMemoryForTests();
        livescoreCalls.length = 0;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        delete globalThis.fetch;
        delete globalThis.caches;
        vi.restoreAllMocks();
    });

    it('rejects a cached startTimestamp outside the 14 day window and fills one inside it', async () => {
        const env = cacheEnv();
        const calls = installFetch({
            data: [{ ...timedRow, date: '2026-11-16' }],
            hasNextPage: false,
        });
        const far = Math.floor(Date.now() / 1000) + 20 * 24 * 60 * 60;
        await seedLivescore(env, [{
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Not Started',
            startTimestamp: far,
        }]);

        const rejected = await worker.fetch(new Request(BOARD), env);
        const rejectedBody = await rejected.json();
        expect(rejectedBody.data[0].startsAtUtc).toBe('');
        expect(rejectedBody.data[0].status).toBe('Not Started');
        expect(rejectedBody.data[0].statusAsOf).toBe('2026-11-16T11:49:00.000Z');
        expect(extraUpstream(calls)).toEqual([]);
        expect(livescoreCalls).toHaveLength(0);

        resetFixtureStatusMemoryForTests();
        const near = Math.floor(Date.now() / 1000) + 3600;
        await seedLivescore(env, [{
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Not Started',
            startTimestamp: near,
        }], '2026-11-16T11:55:00.000Z');
        const accepted = await worker.fetch(new Request(BOARD), env);
        const acceptedBody = await accepted.json();
        expect(acceptedBody.data[0].startsAtUtc).toBe(new Date(near * 1000).toISOString());
        expect(acceptedBody.data[0].time).toBe('');
        expect(accepted.headers.get('Cache-Control')).toBeNull();
        expect(calls).toHaveLength(1);
    });

    it('overlays a cached draw result by composite key without a results fetch', async () => {
        const env = cacheEnv();
        const calls = installFetch({ data: [timedRow], hasNextPage: false });
        await env.TENNIS_CACHE.put('tw:draws14:21362:ATP', JSON.stringify({
            data: {
                rounds: [{
                    matches: [{
                        matchKey: '999001',
                        player1Key: '2315',
                        player2Key: '2072',
                        roundId: 9,
                        status: 'Finished',
                        isLive: false,
                        winner: 'player2',
                        setScores: ['6-3', '6-4'],
                    }],
                }],
            },
            cachedAt: '2026-11-16T11:10:00.000Z',
        }));

        const res = await worker.fetch(new Request(BOARD), env);
        const body = await res.json();
        expect(body.data[0]).toMatchObject({
            matchKey: '88001',
            status: 'Finished',
            isLive: false,
            winner: '2072',
            setScores: ['6-3', '6-4'],
            startsAtUtc: '2026-11-06T14:30:00.000Z',
            statusAsOf: '2026-11-16T11:10:00.000Z',
        });
        expect(extraUpstream(calls)).toEqual([]);
        expect(livescoreCalls).toHaveLength(0);
    });

    it('keeps last-good asOf and an empty statusAsOf when the overlay cache is empty', async () => {
        const env = cacheEnv();
        await rememberFixtures(env, 'ATP', [{
            matchKey: '42',
            tournamentKey: '21362',
            tournamentName: 'Paris',
            date: '2099-01-02',
            time: '11:00',
            startsAtUtc: '',
            status: 'Not Started',
            round: 'Final',
            player1Name: 'Ada',
            player2Name: 'Bea',
            winner: '',
            isLive: false,
            setScores: [],
        }]);
        const calls = installFetch({ data: [] });
        const res = await worker.fetch(new Request(BOARD), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(body.data[0]).toMatchObject({
            matchKey: '42',
            status: 'Not Started',
            statusAsOf: '',
            startsAtUtc: '',
        });
        expect(body.data[0].asOf).toBeUndefined();
        expect(extraUpstream(calls)).toEqual([]);
        expect(res.headers.get('Cache-Control')).toBeNull();
    });
});
