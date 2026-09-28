import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cache } from './cache.js';
import { TTL } from './config.js';
import { getCalendarYear, calendarYearFor } from './calendarYear.js';
import { handleLivescore, livescoreTtlFor } from './routes/livescore.js';
import { handleHub } from './routes/hub.js';
import { handleCalendar } from './routes/calendar.js';
import { handleDraws } from './routes/draws.js';
import { handlePlayerStats } from './routes/playerStats.js';
import { handleScheduled, RANK_SEED_UTC_HOUR } from './index.js';
import { seedRankSnapshots } from './routes/playerRankHistory.js';
import worker from './index.js';

const calendar = vi.fn();
const liveEvents = vi.fn();
const tournamentFixtures = vi.fn();
const tournamentResults = vi.fn();
const tournamentInfo = vi.fn();
const h2h = vi.fn();
const rankingsPaged = vi.fn();
const playerProfile = vi.fn();
const playerTitles = vi.fn();
const playerPastMatches = vi.fn();

vi.mock('./apiClient.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        rapidAPI: {
            ...orig.rapidAPI,
            calendar: (...args) => calendar(...args),
            liveEvents: (...args) => liveEvents(...args),
            tournamentFixtures: (...args) => tournamentFixtures(...args),
            tournamentResults: (...args) => tournamentResults(...args),
            tournamentInfo: (...args) => tournamentInfo(...args),
            h2h: (...args) => h2h(...args),
            rankingsPaged: (...args) => rankingsPaged(...args),
            playerProfile: (...args) => playerProfile(...args),
            playerTitles: (...args) => playerTitles(...args),
            playerPastMatches: (...args) => playerPastMatches(...args),
        },
    };
});

function mockEnv() {
    const store = new Map();
    const puts = [];
    const gets = [];
    return {
        puts,
        gets,
        store,
        CORS_ORIGIN: '*',
        TENNIS_CACHE: {
            async get(key, type) {
                gets.push(key);
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json' || type?.type === 'json') {
                    try { return JSON.parse(raw); } catch { return raw; }
                }
                return raw;
            },
            async put(key, value) {
                puts.push(key);
                store.set(key, value);
            },
            async delete(key) { store.delete(key); },
            _store: store,
        },
    };
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
            async delete() { return true; },
            _store: store,
        },
    };
}

function get(path) {
    return new Request(`https://example.test${path}`, {
        headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });
}

function yearCalls(y) {
    return calendar.mock.calls.filter(args => String(args[2]) === String(y));
}

describe('yearly calendar cache', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        globalThis.fetch = vi.fn(async () => {
            throw new Error('real fetch is not allowed');
        });
        calendar.mockReset();
        calendar.mockResolvedValue({ data: [] });
        liveEvents.mockReset();
        liveEvents.mockResolvedValue([]);
        tournamentFixtures.mockReset();
        tournamentFixtures.mockResolvedValue({ data: [] });
        tournamentResults.mockReset();
        tournamentResults.mockResolvedValue({ data: { singles: [] } });
        tournamentInfo.mockReset();
        tournamentInfo.mockResolvedValue({ data: { name: 'Test Open' } });
        h2h.mockReset();
        h2h.mockResolvedValue({ data: [] });
        rankingsPaged.mockReset();
        rankingsPaged.mockResolvedValue({ data: [] });
        playerProfile.mockReset();
        playerTitles.mockReset();
        playerPastMatches.mockReset();
    });
    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    it('rejects a bad tour or year with 400 and does not create a cache key', async () => {
        const year = new Date().getFullYear();
        await expect(getCalendarYear(env, 'ITF', year)).rejects.toMatchObject({ status: 400 });
        await expect(getCalendarYear(env, 'ATP', 'nope')).rejects.toMatchObject({ status: 400 });
        await expect(getCalendarYear(env, 'ATP', `${year}x`)).rejects.toMatchObject({ status: 400 });
        await expect(getCalendarYear(env, 'ATP', String(year + 5))).rejects.toMatchObject({ status: 400 });
        await expect(getCalendarYear(env, 'ATP', '1990')).rejects.toMatchObject({ status: 400 });
        await expect(handleCalendar(
            get('/api/calendar?tour=CHALLENGER&dateStart=2026-06-01&dateStop=2026-06-30'),
            env,
        )).rejects.toMatchObject({ status: 400 });
        await expect(handleCalendar(
            get('/api/calendar?tour=ATP&dateStart=1990-01-01&dateStop=1990-12-31'),
            env,
        )).rejects.toMatchObject({ status: 400 });

        expect(calendar).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(env.gets).toEqual([]);
        expect(env.puts).toEqual([]);
        expect([...env.store.keys()]).toEqual([]);
    });

    it('fetches each in-window year once and does not key seasons outside the window', async () => {
        const year = new Date().getFullYear();
        calendar.mockResolvedValue({ data: [{ id: 7, name: 'Shared Open' }] });

        const first = await getCalendarYear(env, 'atp', year);
        const second = await getCalendarYear(env, 'ATP', String(year));
        expect(first).toEqual({ data: [{ id: 7, name: 'Shared Open' }] });
        expect(second).toEqual(first);
        expect(yearCalls(year)).toHaveLength(1);

        const keys = [...env.store.keys()];
        expect(keys).toContain(`tw:calendar-year:ATP:${year}`);
        expect(keys).toContain(`tw:calendar-year:ATP:${year}:stale`);
        expect(keys.every(k => k === `tw:calendar-year:ATP:${year}` || k === `tw:calendar-year:ATP:${year}:stale`)).toBe(true);

        calendar.mockClear();
        const old = year - 4;
        await calendarYearFor(env, 'ATP', old);
        expect(calendar).toHaveBeenCalledTimes(1);
        expect([...env.store.keys()].some(k => k.includes(String(old)))).toBe(false);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('reuses one yearly fetch for livescore, hub, and /api/calendar without changing the calendar shape', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const year = Number(today.slice(0, 4));
        const stamp = `${today}T00:00:00.000Z`;
        calendar.mockResolvedValue({
            data: [
                {
                    id: 42,
                    name: 'Test Open',
                    tier: 'ATP 250',
                    date: stamp,
                    court: { name: 'Clay' },
                    coutry: { name: 'France', acronym: 'FRA' },
                    draw_size: 28,
                },
                {
                    id: 99,
                    name: 'Challenger Cup',
                    tier: 'Challenger 125',
                    date: stamp,
                    court: { name: 'Hard' },
                },
            ],
        });
        tournamentFixtures.mockResolvedValue({
            data: [{
                id: 555,
                player1Id: 1,
                player2Id: 2,
                player1: { name: 'Ada' },
                player2: { name: 'Bob' },
                roundId: 12,
                date: today,
            }],
        });

        await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(yearCalls(year)).toHaveLength(1);
        const afterLivescore = calendar.mock.calls.length;

        await handleHub(get('/api/hub?tour=ATP'), env);
        const rows = await handleCalendar(
            get(`/api/calendar?tour=ATP&dateStart=${today}&dateStop=${today}`),
            env,
        );
        expect(calendar.mock.calls.length).toBe(afterLivescore);
        expect(yearCalls(year)).toHaveLength(1);
        expect(globalThis.fetch).not.toHaveBeenCalled();

        expect(rows).toEqual([{
            tournamentKey: '42',
            name: 'Test Open',
            surface: 'Clay',
            season: new Date(stamp).getFullYear(),
            startDate: today,
            endDate: '',
            status: 'live',
            tier: 'ATP 250',
            country: 'France',
            countryCode: 'FRA',
            finished: 0,
            live: 1,
            upcoming: 0,
            totalMatches: 28,
        }]);

        const res = await worker.fetch(
            get(`/api/calendar?tour=wta&dateStart=${today}&dateStop=${today}`),
            env,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.data).toEqual([{
            ...rows[0],
        }]);
        // WTA is a different tour key, so this is the one extra yearly read.
        expect(yearCalls(year)).toHaveLength(2);
        expect([...env.store.keys()].some(k => k.startsWith('tw:calendar2:'))).toBe(false);
        expect([...env.store.keys()].filter(k => k.includes('hub') || k.includes('livescore'))).toEqual([]);
    });
});

describe('livescore TTL stays edge-only', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        globalThis.fetch = vi.fn(async () => { throw new Error('real fetch is not allowed'); });
        calendar.mockReset();
        liveEvents.mockReset();
        tournamentFixtures.mockReset();
        tournamentResults.mockReset();
        h2h.mockReset();
    });
    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    it('uses 60s when anything is live, scheduled, or delayed, and does not put the board in KV', async () => {
        expect(TTL.livescore).toBe(60);
        expect(livescoreTtlFor([{ isLive: true, status: 'Live' }])).toBe(60);
        expect(livescoreTtlFor([{ isLive: false, status: 'Not Started' }])).toBe(60);
        expect(livescoreTtlFor([{ isLive: false, status: 'Delayed' }])).toBe(60);
        expect(livescoreTtlFor([{ isLive: false, status: 'Finished' }])).toBe(TTL.livescoreIdle);

        const today = new Date().toISOString().slice(0, 10);
        const year = new Date().getFullYear();
        calendar.mockResolvedValue({
            data: [{ id: 20340, name: 'US Open', tier: 'Grand Slam', date: `${today}T00:00:00.000Z` }],
        });
        await getCalendarYear(env, 'ATP', year);
        env.puts.length = 0;

        liveEvents.mockResolvedValue([]);
        tournamentFixtures.mockResolvedValue({
            data: [{
                id: 555,
                player1Id: 2072,
                player2Id: 2315,
                player1: { name: 'J. Sinner' },
                player2: { name: 'C. Alcaraz' },
                roundId: 12,
                date: today,
            }],
        });
        tournamentResults.mockResolvedValue({ data: { singles: [] } });

        const edgeSpy = vi.spyOn(cache, 'setEdge');
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(data.some(m => m.status === 'Not Started')).toBe(true);
        expect(edgeSpy).toHaveBeenCalledWith(
            60,
            expect.any(Array),
            'livescore3',
            'ATP',
            'all',
            expect.objectContaining({ fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) }),
        );
        expect(env.puts).toEqual([]);
        expect([...env.store.keys()].filter(k => k.includes('livescore'))).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

describe('cron rank snapshots', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        globalThis.fetch = vi.fn(async () => { throw new Error('real fetch is not allowed'); });
        calendar.mockReset();
        calendar.mockResolvedValue({ data: [{ id: 1, name: 'Warm Open', tier: 'ATP 250', date: '2026-07-15' }] });
        rankingsPaged.mockReset();
        rankingsPaged.mockImplementation(async (_env, tour) => ({
            data: [{
                position: 1,
                point: 9000,
                date: '2026-07-14',
                player: {
                    id: tour === 'WTA' ? 12345 : 47275,
                    name: tour === 'WTA' ? 'Sabalenka' : 'Sinner',
                    countryAcr: 'ITA',
                },
            }],
        }));
    });
    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    it('seeds rank snapshots only at UTC hour 12 and still warms standings', async () => {
        expect(RANK_SEED_UTC_HOUR).toBe(12);
        const y = new Date().getFullYear();
        const at = (hour) => Date.UTC(y, 6, 15, hour, 0, 0);

        await handleScheduled(env, { scheduledTime: at(6) });
        const keys = () => [...env.store.keys()];
        expect(keys().some(k => k.startsWith('tw:rank-history:'))).toBe(false);
        expect(keys()).toContain('tw:standings2:ATP');
        expect(keys()).toContain('tw:standings2:WTA');
        expect(keys()).toContain(`tw:calendar-year:ATP:${y}`);
        expect(keys()).toContain(`tw:calendar-year:WTA:${y}`);
        const rankingCalls = rankingsPaged.mock.calls.length;
        expect(rankingCalls).toBeGreaterThan(0);

        await handleScheduled(env, { scheduledTime: at(12) });
        expect(keys()).toContain('tw:rank-history:v1:ATP:47275');
        expect(keys()).toContain('tw:rank-history:v1:WTA:12345');
        expect(JSON.parse(env.store.get('tw:rank-history:v1:ATP:47275'))).toEqual([
            { date: '2026-07-14', rank: 1 },
        ]);
        expect(rankingsPaged.mock.calls.length).toBe(rankingCalls);

        installMockCaches();
        const later = mockEnv();
        await handleScheduled(later, { scheduledTime: at(18) });
        expect([...later.store.keys()].some(k => k.startsWith('tw:rank-history:'))).toBe(false);
        expect([...later.store.keys()]).toContain('tw:standings2:ATP');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('stores a Monday ranking under Monday when the job runs Tuesday, and does not rewrite that week', async () => {
        const monday = '2026-09-21';
        const tuesdayNoon = Date.UTC(2026, 8, 22, 12, 0, 0);
        const thursdayNoon = Date.UTC(2026, 8, 24, 12, 0, 0);
        rankingsPaged.mockImplementation(async (_env, tour) => ({
            data: [{
                position: 1,
                point: 9000,
                date: `${monday}T00:00:00.000Z`,
                player: {
                    id: tour === 'WTA' ? 12345 : 47275,
                    name: tour === 'WTA' ? 'Sabalenka' : 'Sinner',
                    countryAcr: 'ITA',
                },
            }],
        }));

        await handleScheduled(env, { scheduledTime: tuesdayNoon });

        const atp = JSON.parse(env.store.get('tw:rank-history:v1:ATP:47275'));
        const wta = JSON.parse(env.store.get('tw:rank-history:v1:WTA:12345'));
        expect(atp).toEqual([{ date: monday, rank: 1 }]);
        expect(wta).toEqual([{ date: monday, rank: 1 }]);
        expect(atp[0].date).not.toBe('2026-09-22');
        expect(env.puts.filter(k => k.startsWith('tw:rank-history:')).sort()).toEqual([
            'tw:rank-history:v1:ATP:47275',
            'tw:rank-history:v1:WTA:12345',
        ]);

        env.puts.length = 0;
        await handleScheduled(env, { scheduledTime: thursdayNoon });
        expect(env.puts.filter(k => k.startsWith('tw:rank-history:'))).toEqual([]);
        expect(JSON.parse(env.store.get('tw:rank-history:v1:ATP:47275'))).toEqual(atp);

        env.puts.length = 0;
        await seedRankSnapshots(env, 'ATP', [
            { playerKey: '999', rank: 3 },
            { playerKey: '998', rank: 4, rankingDate: '' },
            { playerKey: '997', rank: 5, date: 'not-a-date' },
        ]);
        expect(env.puts.filter(k => k.startsWith('tw:rank-history:'))).toEqual([]);
        expect(env.store.has('tw:rank-history:v1:ATP:999')).toBe(false);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

describe('draws ranks from cached standings', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        globalThis.fetch = vi.fn(async () => { throw new Error('real fetch is not allowed'); });
        rankingsPaged.mockReset();
        rankingsPaged.mockResolvedValue({
            data: [{ position: 9, player: { id: 101 } }, { position: 40, player: { id: 202 } }],
        });
        tournamentResults.mockReset();
        tournamentResults.mockResolvedValue({
            data: {
                singles: [{
                    id: 1,
                    date: '2026-09-20',
                    roundId: 7,
                    player1Id: 101,
                    player2Id: 202,
                    match_winner: 101,
                    result: '6-4 6-3',
                    player1: { name: 'Ada' },
                    player2: { name: 'Bob' },
                }],
            },
        });
        tournamentFixtures.mockReset();
        tournamentFixtures.mockResolvedValue({ data: [] });
        tournamentInfo.mockReset();
        tournamentInfo.mockResolvedValue({ data: { name: 'Test Open' } });
    });
    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    function matchRanks(data) {
        const match = data.rounds.flatMap(r => r.matches)[0];
        return { p1: match.player1Rank, p2: match.player2Rank };
    }

    it('does not call rankingsPaged when standings2 is hot', async () => {
        await cache.set(env, 3600, [
            { playerKey: '101', rank: 4 },
            { playerKey: '202', rank: 15 },
        ], 'standings2', 'ATP');
        rankingsPaged.mockClear();

        const data = await handleDraws(get('/api/draws?tournamentKey=9001&tour=ATP'), env);
        expect(rankingsPaged).not.toHaveBeenCalled();
        expect(matchRanks(data)).toEqual({ p1: 4, p2: 15 });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('falls back to rankingsPaged when the standings cache is empty', async () => {
        await cache.set(env, 3600, [], 'standings2', 'ATP');
        const data = await handleDraws(get('/api/draws?tournamentKey=9002&tour=ATP'), env);
        expect(rankingsPaged).toHaveBeenCalledTimes(1);
        expect(matchRanks(data)).toEqual({ p1: 9, p2: 40 });
    });
});

describe('player profile edge miss', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        globalThis.fetch = vi.fn(async () => { throw new Error('real fetch is not allowed'); });
        playerProfile.mockReset();
        playerTitles.mockReset();
        playerPastMatches.mockReset();
        calendar.mockReset();
        calendar.mockResolvedValue({ data: [] });
    });
    afterEach(() => {
        delete globalThis.caches;
        delete globalThis.fetch;
        vi.restoreAllMocks();
    });

    it('caches past matches for 24h', async () => {
        const year = new Date().getFullYear();
        playerPastMatches.mockResolvedValue({
            data: [{ match_winner: 77, date: `${year}-03-01` }],
        });
        playerTitles.mockResolvedValue({ data: [] });
        playerProfile.mockResolvedValue({ data: { birthday: '1990-01-01T00:00:00.000Z' } });
        const setSpy = vi.spyOn(cache, 'set');

        await handlePlayerStats(get('/api/player-stats?tour=ATP&playerKey=77'), env);

        expect(TTL.playerPastMatches).toBe(24 * 60 * 60);
        expect(setSpy).toHaveBeenCalledWith(
            env,
            TTL.playerPastMatches,
            expect.any(Array),
            'player-past-matches-200',
            'ATP',
            '77',
        );
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('stores a no-birthday profile with setEdge and no KV put', async () => {
        const year = new Date().getFullYear();
        await cache.set(env, 3600, 3, 'player-titles', 'ATP', '55');
        await cache.set(env, 3600, [{ match_winner: 55, date: `${year}-01-15` }], 'player-past-matches-200', 'ATP', '55');
        await cache.set(env, 3600, { 1: { name: 'X', surface: 'hard' } }, 'tournament-map-v6', 'ATP');
        env.puts.length = 0;

        playerProfile.mockResolvedValue({ data: { id: 55, name: 'No Birthday' } });
        const edgeSpy = vi.spyOn(cache, 'setEdge');

        const stats = await handlePlayerStats(get('/api/player-stats?tour=ATP&playerKey=55'), env);
        expect(stats.birthday).toBeNull();
        expect(edgeSpy).toHaveBeenCalledWith(
            TTL.edgeMiss,
            { miss: true },
            'player-profile-miss',
            'ATP',
            '55',
        );
        expect(TTL.edgeMiss).toBe(10 * 60);
        expect(env.puts).toEqual([]);
        expect([...env.store.keys()].some(k => k.includes('player-profile'))).toBe(false);

        playerProfile.mockClear();
        const again = await handlePlayerStats(get('/api/player-stats?tour=ATP&playerKey=55'), env);
        expect(again.birthday).toBeNull();
        expect(playerProfile).not.toHaveBeenCalled();
        expect(env.puts).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('stores an upstream profile error as an edge miss and does not put KV', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const year = new Date().getFullYear();
        await cache.set(env, 3600, 1, 'player-titles', 'ATP', '56');
        await cache.set(env, 3600, [{ match_winner: 56, date: `${year}-02-02` }], 'player-past-matches-200', 'ATP', '56');
        await cache.set(env, 3600, {}, 'tournament-map-v6', 'ATP');
        env.puts.length = 0;

        playerProfile.mockRejectedValue(new Error('Upstream request failed'));
        const edgeSpy = vi.spyOn(cache, 'setEdge');
        const stats = await handlePlayerStats(get('/api/player-stats?tour=ATP&playerKey=56'), env);
        expect(stats.birthday).toBeNull();
        expect(edgeSpy).toHaveBeenCalledWith(
            TTL.edgeMiss,
            { miss: true },
            'player-profile-miss',
            'ATP',
            '56',
        );
        expect(env.puts).toEqual([]);
    });
});
