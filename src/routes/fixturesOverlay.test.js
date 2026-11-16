import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { createMemoryD1 } from '../d1Memory.js';
import { rememberFixtures } from '../d1Store.js';
import { resetQuotaStopStateForTests } from '../quotaStop.js';
import { normalizeFixturesFeed } from '../transforms/fixturesFeed.js';
import { MAX_FIXTURE_DRAW_READS, resetFixtureStatusMemoryForTests } from './fixtures.js';

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

    it('upgrades an inferred walkover once either cache gains set scores', async () => {
        const env = cacheEnv();
        const calls = installFetch({ data: [timedRow], hasNextPage: false });
        const scoreless = {
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Finished',
            winner: '2072',
            setScores: [],
        };
        await seedLivescore(env, [scoreless]);

        const first = await (await worker.fetch(new Request(BOARD), env)).json();
        expect(first.data[0].status).toBe('Walkover');
        expect(first.data[0].winner).toBe('2072');

        await seedLivescore(env, [{ ...scoreless, setScores: ['6-4', '6-3'] }]);
        const later = await (await worker.fetch(new Request(BOARD), env)).json();
        expect(later.data[0]).toMatchObject({
            status: 'Finished',
            winner: '2072',
            setScores: ['6-4', '6-3'],
            isLive: false,
        });
        expect(extraUpstream(calls)).toEqual([]);
        expect(livescoreCalls).toHaveLength(0);
    });

    it('resolves a scoreless cache and a scored cache to Finished in either order', async () => {
        const env = cacheEnv();
        const calls = installFetch({ data: [timedRow], hasNextPage: false });
        await seedLivescore(env, [{
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Finished',
            winner: '2072',
            setScores: [],
        }]);
        await env.TENNIS_CACHE.put('tw:draws14:21362:ATP', JSON.stringify({
            data: {
                rounds: [{
                    matches: [{
                        matchKey: '999001',
                        player1Key: '2315',
                        player2Key: '2072',
                        roundId: 9,
                        status: 'Finished',
                        winner: 'player2',
                        setScores: ['7-6', '6-4'],
                    }],
                }],
            },
            cachedAt: '2026-11-16T11:12:00.000Z',
        }));

        const livescoreFirst = await (await worker.fetch(new Request(BOARD), env)).json();
        expect(livescoreFirst.data[0]).toMatchObject({
            status: 'Finished',
            winner: '2072',
            setScores: ['7-6', '6-4'],
        });

        resetFixtureStatusMemoryForTests();
        const other = cacheEnv();
        installFetch({ data: [timedRow], hasNextPage: false });
        await seedLivescore(other, [{
            matchKey: '88001',
            player1Key: '2072',
            player2Key: '2315',
            tournamentKey: '21362',
            roundId: 9,
            status: 'Finished',
            winner: '2072',
            setScores: ['6-2', '6-2'],
        }]);
        await other.TENNIS_CACHE.put('tw:draws14:21362:ATP', JSON.stringify({
            data: {
                rounds: [{
                    matches: [{
                        matchKey: '999001',
                        player1Key: '2072',
                        player2Key: '2315',
                        roundId: 9,
                        status: 'Finished',
                        winner: '2072',
                        setScores: [],
                    }],
                }],
            },
            cachedAt: '2026-11-16T11:12:00.000Z',
        }));
        const scoresFirst = await (await worker.fetch(new Request(BOARD), other)).json();
        expect(scoresFirst.data[0]).toMatchObject({
            status: 'Finished',
            winner: '2072',
            setScores: ['6-2', '6-2'],
        });
        expect(extraUpstream(calls)).toEqual([]);
        expect(livescoreCalls).toHaveLength(0);
    });
});

function installEdgeCache() {
    const store = new Map();
    const edge = [];
    const cacheApi = {
        async match(req) {
            const url = typeof req === 'string' ? req : req.url;
            edge.push(url);
            const entry = store.get(url);
            if (!entry) return undefined;
            return new Response(entry.body, { status: 200, headers: entry.headers });
        },
        async put(req, response) {
            const url = typeof req === 'string' ? req : req.url;
            const headers = {};
            response.headers.forEach((value, key) => { headers[key] = value; });
            store.set(url, { body: await response.clone().text(), headers });
        },
        store,
    };
    globalThis.caches = { default: cacheApi };
    return { edge, store };
}

function storedRow(id, tier) {
    const tournamentKey = String(2000 + id);
    return {
        matchKey: String(80000 + id),
        tournamentKey,
        tournamentName: tier === 'tour' ? `ATP 500 ${id}` : `Challenger ${id}`,
        tier,
        date: '2026-11-16',
        time: '',
        startsAtUtc: '',
        status: 'Not Started',
        round: 'Final',
        roundId: 12,
        season: '2026',
        eventType: 'ATP Singles',
        player1Key: String(id),
        player1Name: `A ${id}`,
        player2Key: String(id + 100),
        player2Name: `B ${id}`,
        player1Logo: '',
        player2Logo: '',
        finalResult: '',
        winner: '',
        isLive: false,
        setScores: [],
        currentGame: null,
    };
}

describe('fixture overlay cache budget', () => {
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

    it('caps draw cache reads at 5 and serves the next view from the edge', async () => {
        const env = cacheEnv();
        const calls = installFetch({ data: [] });
        const { edge, store } = installEdgeCache();
        const kv = [];
        const innerGet = env.TENNIS_CACHE.get.bind(env.TENNIS_CACHE);
        env.TENNIS_CACHE.get = async (key, type) => {
            kv.push(String(key));
            return innerGet(key, type);
        };

        const rows = [];
        for (let id = 1; id <= 8; id++) rows.push(storedRow(id, 'tour'));
        rows.push(storedRow(101, 'challenger'));
        rows.push(storedRow(102, 'challenger'));
        rows[0].session = 'session-SENTINEL';
        rows[0].memberId = 'member-SENTINEL';
        await env.TENNIS_CACHE.put('tw:fixtures5:ATP:all::', JSON.stringify({
            data: rows,
            cachedAt: '2026-11-16T11:00:00.000Z',
            stale: false,
        }));
        await seedLivescore(env, [{
            matchKey: rows[0].matchKey,
            player1Key: rows[0].player1Key,
            player2Key: rows[0].player2Key,
            tournamentKey: rows[0].tournamentKey,
            roundId: 12,
            status: 'Live',
            isLive: true,
            setScores: ['4-3'],
            session: 'live-session-SENTINEL',
            email: 'member@example.test',
        }]);

        kv.length = 0;
        const first = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), env);
        const body = await first.json();
        expect(first.status).toBe(200);
        expect(body.data).toHaveLength(rows.length);
        expect(body.data[0].status).toBe('Live');
        expect(JSON.stringify(body)).not.toContain('SENTINEL');
        expect(JSON.stringify(body)).not.toContain('member@example.test');

        const drawGets = kv.filter(key => key.startsWith('tw:draws14:'));
        expect(drawGets.length).toBe(MAX_FIXTURE_DRAW_READS);
        expect(drawGets.length).toBeLessThanOrEqual(5);
        expect(drawGets.some(key => key.includes(':2101:') || key.includes(':2102:'))).toBe(false);
        const liveGets = kv.filter(key => key.startsWith('tw:livescore3:'));
        expect(liveGets.length).toBeLessThanOrEqual(4);
        expect(calls).toEqual([]);
        expect(livescoreCalls).toHaveLength(0);

        const edgeEntry = [...store.entries()].find(([url]) => url.includes('fixtures-overlay'));
        expect(edgeEntry).toBeTruthy();
        const cacheControl = Object.entries(edgeEntry[1].headers)
            .find(([key]) => key.toLowerCase() === 'cache-control')?.[1];
        expect(cacheControl).toBe('public, max-age=60');
        expect(edgeEntry[1].body).not.toContain('SENTINEL');
        expect(edgeEntry[1].body).not.toContain('member@example.test');
        expect(edgeEntry[1].body).not.toContain('session');

        const kvAfterFirst = kv.length;
        const edgeAfterFirst = edge.length;
        const second = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), env);
        const again = await second.json();
        expect(again.data[0].status).toBe('Live');
        expect(kv.length).toBe(kvAfterFirst);
        expect(edge.slice(edgeAfterFirst).some(url => url.includes('/draws14/') || url.includes('draws14'))).toBe(false);
        expect(calls).toEqual([]);
    });

    it('still reads a requested non-tour tournamentKey and stops at 5 draw reads', async () => {
        const env = cacheEnv();
        const calls = installFetch({ data: [] });
        installEdgeCache();
        const kv = [];
        const innerGet = env.TENNIS_CACHE.get.bind(env.TENNIS_CACHE);
        env.TENNIS_CACHE.get = async (key, type) => {
            kv.push(String(key));
            return innerGet(key, type);
        };
        const rows = [storedRow(301, 'challenger')];
        for (let id = 1; id <= 6; id++) rows.push(storedRow(id, 'tour'));
        rows[0].tournamentKey = '3001';
        await env.TENNIS_CACHE.put('tw:fixtures5:ATP:3001::', JSON.stringify({
            data: rows,
            cachedAt: '2026-11-16T11:00:00.000Z',
            stale: false,
        }));

        kv.length = 0;
        const res = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP&tournamentKey=3001'), env);
        expect(res.status).toBe(200);
        const drawGets = kv.filter(key => key.startsWith('tw:draws14:'));
        expect(drawGets).toContain('tw:draws14:3001:ATP');
        expect(drawGets.length).toBe(MAX_FIXTURE_DRAW_READS);
        expect(kv.filter(key => key.startsWith('tw:livescore3:')).length).toBeLessThanOrEqual(4);
        expect(calls).toEqual([]);
        expect(livescoreCalls).toHaveLength(0);
    });
});
