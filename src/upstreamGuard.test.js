import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { apiTennis, rapidAPI } from './apiClient.js';
import { createMemoryD1 } from './d1Memory.js';
import { rememberApiTennisList, rememberDraw, rememberFixtures, rememberStandings, rememberTournaments } from './d1Store.js';
import { QUOTA_CALL_TALLY_EDGE, resetQuotaStopStateForTests } from './quotaStop.js';

const TENNIS_KEY = 'super-secret-tennis-key';
const RAPID_KEY = 'super-secret-rapid-key';

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
    return store;
}

function cacheEnv(extra = {}) {
    const store = new Map();
    return {
        CORS_ORIGIN: '*',
        TENNIS_API_KEY: TENNIS_KEY,
        RAPIDAPI_KEY: RAPID_KEY,
        DEMO_MODE: 'false',
        RAPIDAPI_HARD_STOP: 'on',
        API_TENNIS_HARD_STOP: 'on',
        ADMIN_SECRET: 'test-admin-secret',
        D1_DAILY_WRITE_BUDGET: '20',
        D1_BACKFILL_BATCH: '5',
        RAPIDAPI_DAILY_CALL_CAP: '20',
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
        calls.push({ url: String(url), headers: init?.headers || {} });
        return handler(String(url), init);
    });
    return calls;
}

function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function assertNoSecret(text) {
    expect(text).not.toContain(TENNIS_KEY);
    expect(text).not.toContain(RAPID_KEY);
    expect(text).not.toContain('api.api-tennis.com');
    expect(text).not.toContain('APIkey=');
}

describe('upstream key and backfill caps', () => {
    let logs;
    beforeEach(() => {
        resetQuotaStopStateForTests();
        installCaches();
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

    it('never logs or returns the API-Tennis URL that carries TENNIS_API_KEY', async () => {
        const env = cacheEnv();
        const calls = installFetch((url) => {
            throw new TypeError(`Failed to fetch ${url}`);
        });
        await expect(apiTennis.tournaments(env, '1')).rejects.toThrow('Upstream request failed');
        const res = await worker.fetch(new Request('https://example.test/api/tournaments?tour=ATP'), env);
        const text = await res.text();
        assertNoSecret(text);
        assertNoSecret(logs.join('\n'));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.some(call => call.url.includes(TENNIS_KEY))).toBe(true);
    });

    it('after a 429 trips the stop, saved routes serve D1 and make no further outbound call', async () => {
        const env = cacheEnv();
        const today = new Date().toISOString().slice(0, 10);
        await rememberFixtures(env, 'ATP', [{
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
        await rememberStandings(env, 'ATP', [
            { playerKey: '5', rank: 1, name: 'Stored', points: 10, tour: 'ATP' },
        ], { replace: true });
        await rememberTournaments(env, 'ATP', [{
            id: 42,
            name: 'Test Open',
            tier: 'ATP 250',
            date: `${today}T00:00:00.000Z`,
            court: { name: 'Clay' },
            coutry: { name: 'France', acronym: 'FRA' },
        }], { replace: true });
        await rememberDraw(env, 'ATP', '9001', {
            tournamentKey: '9001',
            name: 'Stored Open',
            totalMatches: 0,
            rounds: [],
        });

        const calls = installFetch(() => new Response('slow down', { status: 429 }));
        const tripped = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), env);
        const trippedBody = await tripped.json();
        expect(tripped.status).toBe(200);
        expect(trippedBody.data[0].matchKey).toBe('88001');
        expect(trippedBody.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(calls).toHaveLength(1);

        const paths = [
            '/api/fixtures?tour=ATP',
            '/api/standings?tour=ATP',
            `/api/calendar?tour=ATP&dateStart=${today}&dateStop=${today}`,
            '/api/draws?tournamentKey=9001&tour=ATP',
        ];
        for (const path of paths) {
            const res = await worker.fetch(new Request(`https://example.test${path}`), env);
            const text = await res.text();
            const body = JSON.parse(text);
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(body.data).toBeTruthy();
            assertNoSecret(text);
        }
        expect(calls).toHaveLength(1);
        assertNoSecret(logs.join('\n'));
    });

    it('backfill spends the D1 write budget and the daily upstream cap', async () => {
        const env = cacheEnv({
            D1_DAILY_WRITE_BUDGET: '2',
            D1_BACKFILL_BATCH: '5',
            RAPIDAPI_DAILY_CALL_CAP: '1',
        });
        const calls = installFetch(() => jsonRes({
            data: [{
                id: 77,
                date: '2099-01-01T12:00:00.000Z',
                roundId: 12,
                tournament: { id: 5, name: 'Paris' },
                player1Id: 1,
                player2Id: 2,
                player1: { id: 1, name: 'A' },
                player2: { id: 2, name: 'B' },
            }],
            hasNextPage: false,
        }));
        const post = () => worker.fetch(new Request('https://example.test/api/admin/backfill-last-good', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-secret': 'test-admin-secret',
            },
            body: JSON.stringify({ resource: 'fixtures', tour: 'ATP' }),
        }), env);

        const first = await post();
        const firstBody = await first.json();
        expect(first.status).toBe(200);
        expect(firstBody.data.written).toBe(1);
        expect(env.DB._tables.d1_write_ledger[0].writes).toBeGreaterThan(0);
        const tally = JSON.parse(globalThis.caches.default._store.get(QUOTA_CALL_TALLY_EDGE).body);
        expect(tally.count).toBe(1);
        expect(calls).toHaveLength(1);

        const second = await post();
        const secondText = await second.text();
        expect(second.status).toBe(500);
        expect(JSON.parse(secondText).error).toBe('Upstream request failed');
        expect(calls).toHaveLength(1);
        assertNoSecret(secondText);

        const blocked = cacheEnv({ D1_DAILY_WRITE_BUDGET: '0', RAPIDAPI_DAILY_CALL_CAP: '5' });
        const blockedCalls = installFetch(() => jsonRes({ data: [] }));
        const skipped = await worker.fetch(new Request('https://example.test/api/admin/backfill-last-good', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-secret': 'test-admin-secret',
            },
            body: JSON.stringify({ resource: 'fixtures', tour: 'ATP' }),
        }), blocked);
        const skippedBody = await skipped.json();
        expect(skipped.status).toBe(200);
        expect(skippedBody.data).toMatchObject({ written: 0, budget: true });
        expect(blockedCalls).toHaveLength(0);
    });

    it('serves D1 with no further RapidAPI call once RAPIDAPI_DAILY_CALL_CAP is hit, and a new UTC day starts over', async () => {
        const env = cacheEnv({ RAPIDAPI_DAILY_CALL_CAP: '1' });
        await rememberFixtures(env, 'ATP', [{
            matchKey: '42',
            tournamentKey: '7',
            tournamentName: 'Paris',
            date: '2099-01-02',
            time: '11:00',
            status: 'Not Started',
            round: 'Final',
            player1Name: 'Ada',
            player2Name: 'Bea',
        }]);
        await globalThis.caches.default.put(QUOTA_CALL_TALLY_EDGE, new Response(
            JSON.stringify({ day: '2000-01-01', count: 50 }),
            { headers: { 'Content-Type': 'application/json' } },
        ));
        const calls = installFetch(() => jsonRes({
            data: [{ position: 1, player: { id: 1, name: 'A' } }],
        }));
        await rapidAPI.rankings(env, 'ATP', 5);
        expect(calls).toHaveLength(1);

        const capped = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), env);
        const body = await capped.json();
        expect(capped.status).toBe(200);
        expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(body.data[0]).toMatchObject({ matchKey: '42', tournamentName: 'Paris' });
        expect(calls).toHaveLength(1);
        assertNoSecret(JSON.stringify(body));
    });

    it('fails closed when a daily call counter read or write throws, and serves D1', async () => {
        async function seed(env) {
            await rememberFixtures(env, 'ATP', [{
                matchKey: '42',
                tournamentKey: '7',
                tournamentName: 'Paris',
                date: '2099-01-02',
                time: '11:00',
                status: 'Not Started',
                round: 'Final',
                player1Name: 'Ada',
                player2Name: 'Bea',
            }]);
            await rememberApiTennisList(env, 'tournaments', 'ATP', [{
                tournamentKey: '2004',
                name: 'Madrid',
            }]);
        }
        function breakCounter(which) {
            const cache = globalThis.caches.default;
            const match = cache.match.bind(cache);
            const put = cache.put.bind(cache);
            const isTally = (req) => String(req?.url || req).includes('call-tally');
            cache.match = async (req) => {
                if (which === 'read' && isTally(req)) throw new Error('tally read failed');
                return match(req);
            };
            cache.put = async (req, res) => {
                if (which === 'write' && isTally(req)) throw new Error('tally write failed');
                return put(req, res);
            };
        }
        async function expectStored(env, path, needle) {
            const res = await worker.fetch(new Request(`https://example.test${path}`), env);
            const text = await res.text();
            const body = JSON.parse(text);
            expect(res.status).toBe(200);
            expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(text).toContain(needle);
            assertNoSecret(text);
            assertNoSecret(logs.join('\n'));
        }

        for (const which of ['read', 'write']) {
            const env = cacheEnv({ RAPIDAPI_DAILY_CALL_CAP: '50', API_TENNIS_DAILY_CAP: '100' });
            await seed(env);
            breakCounter(which);
            const calls = installFetch(() => { throw new Error('fetch must not be called'); });
            await expectStored(env, '/api/fixtures?tour=ATP', 'Paris');
            await expectStored(env, '/api/tournaments?tour=ATP', 'Madrid');
            expect(calls).toHaveLength(0);
        }
    });
});
