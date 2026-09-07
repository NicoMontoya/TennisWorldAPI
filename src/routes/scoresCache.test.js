import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TTL } from '../config.js';
import { cache } from '../cache.js';
import { handleLivescore } from './livescore.js';
import { handleHub } from './hub.js';
import { RL_PER_MINUTE, rateLimitCacheUrl } from '../security.js';
import worker from '../index.js';

const calendar = vi.fn();
const tournamentResults = vi.fn();
const tournamentFixtures = vi.fn();
const h2h = vi.fn();
const liveEvents = vi.fn();

vi.mock('../apiClient.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        rapidAPI: {
            ...orig.rapidAPI,
            calendar: (...args) => calendar(...args),
            tournamentResults: (...args) => tournamentResults(...args),
            tournamentFixtures: (...args) => tournamentFixtures(...args),
            h2h: (...args) => h2h(...args),
            liveEvents: (...args) => liveEvents(...args),
        },
    };
});

function seedLiveEvents() {
    liveEvents.mockResolvedValue([{
        id: '9990001',
        participant1: 'C. Alcaraz',
        participant2: 'H. Hurkacz',
        league: 'Roland Garros',
        score: '4-2',
        status: 'InPlay',
        points: '30-0',
        tourType: 'ATP',
        matchId: '2315-2109-3001-5',
    }]);
    calendar.mockResolvedValue({ data: [] });
    tournamentFixtures.mockResolvedValue({ data: [] });
    tournamentResults.mockResolvedValue({ data: { singles: [] } });
}

function mockEnv({ kvPutThrows = false } = {}) {
    const store = new Map();
    return {
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
                if (kvPutThrows && String(key).startsWith('tw:')) {
                    throw new Error('KV put() limit exceeded for the day.');
                }
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
    const edge = {
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
    globalThis.caches = { default: edge };
    return edge;
}

function get(path, ip = '203.0.113.8') {
    return new Request(`https://example.test${path}`, {
        headers: { 'CF-Connecting-IP': ip },
    });
}

function seedHubUpstream() {
    const today = new Date().toISOString().slice(0, 10);
    calendar.mockResolvedValue({
        data: [{ id: 99, name: 'Test Open', tier: 'ATP 250', date: today }],
    });
    tournamentResults.mockResolvedValue({
        data: {
            singles: [{
                id: 1,
                player1Id: '10',
                player2Id: '20',
                player1: { name: 'Ada' },
                player2: { name: 'Bob' },
                match_winner: '10',
                result: '6-4 6-3',
                roundId: 12,
                date: today,
            }],
        },
    });
    tournamentFixtures.mockResolvedValue({ data: [] });
    h2h.mockResolvedValue({ data: [] });
}

describe('hub/livescore cache freshness + fail-soft', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        calendar.mockReset();
        tournamentResults.mockReset();
        tournamentFixtures.mockReset();
        h2h.mockReset();
        liveEvents.mockReset();
        seedLiveEvents();
    });
    afterEach(() => {
        delete globalThis.caches;
        vi.restoreAllMocks();
    });

    it('caches live livescore at TTL.livescore (30s) and skips the :stale KV write', async () => {
        const setSpy = vi.spyOn(cache, 'set');
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(Array.isArray(data)).toBe(true);
        expect(data.some(m => m.isLive)).toBe(true);
        expect(setSpy).toHaveBeenCalledWith(
            env,
            TTL.livescore,
            expect.any(Array),
            'livescore3',
            'ATP',
            'all',
            { skipStale: true },
        );
        const kvKeys = [...env.TENNIS_CACHE._store.keys()];
        expect(kvKeys).toContain('tw:livescore3:ATP:all');
        expect(kvKeys.some(k => k.endsWith(':stale'))).toBe(false);
        expect(kvKeys.filter(k => k.startsWith('_rl:'))).toEqual([]);
    });

    it('returns freshly computed livescore data when KV put quota is exhausted', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        env = mockEnv({ kvPutThrows: true });
        const data = await handleLivescore(get('/api/livescore?tour=ATP'), env);
        expect(data.some(m => m.isLive)).toBe(true);
        expect(data[0].player1Name).toMatch(/Alcaraz/i);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('tw:'))).toEqual([]);
    });

    it('maps livescore KV quota exhaustion to HTTP 200 { ok:true, data }', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        env = mockEnv({ kvPutThrows: true });
        env.CORS_ORIGIN = '*';
        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.data.some(m => m.isLive)).toBe(true);
        const dumped = JSON.stringify(body);
        expect(dumped).not.toMatch(/RAPIDAPI_KEY|TENNIS_API_KEY|X-RapidAPI-Key/i);
        expect(body.data.every(m => !String(m.matchKey || '').includes('9990001'))).toBe(true);
    });

    it('returns freshly computed hub data when KV put quota is exhausted', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        env = mockEnv({ kvPutThrows: true });
        seedHubUpstream();
        const data = await handleHub(get('/api/hub?tour=ATP'), env);
        expect(data.tournament).toMatchObject({ key: '99', name: 'Test Open' });
        expect(data.featuredMatch.player1Name).toBe('Ada');
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('tw:'))).toEqual([]);
    });

    it('maps hub KV quota exhaustion to HTTP 200 { ok:true, data }', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        env = mockEnv({ kvPutThrows: true });
        env.CORS_ORIGIN = '*';
        seedHubUpstream();
        const res = await worker.fetch(get('/api/hub?tour=ATP'), env);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.data.tournament.name).toBe('Test Open');
    });

    it('merges MatchStat InPlay onto hub todaysMatches and featured on a fresh fetch', async () => {
        const today = new Date().toISOString().slice(0, 10);
        calendar.mockResolvedValue({
            data: [{ id: 16743, name: 'U.S. Open', tier: 'Grand Slam', date: today }],
        });
        tournamentFixtures.mockResolvedValue({
            data: [
                {
                    id: 866,
                    player1Id: 18455,
                    player2Id: 66597,
                    player1: { name: 'Aryna Sabalenka' },
                    player2: { name: 'Linda Noskova' },
                    seed1: '1',
                    seed2: '6',
                    roundId: 9,
                    date: `${today}T18:30:00.000Z`,
                },
                {
                    id: 889,
                    player1Id: 32480,
                    player2Id: 42098,
                    player1: { name: 'Anna Kalinskaya' },
                    player2: { name: 'Emma Navarro' },
                    seed1: '21',
                    seed2: '26',
                    roundId: 7,
                    date: today,
                },
            ],
        });
        tournamentResults.mockResolvedValue({ data: { singles: [] } });
        h2h.mockResolvedValue({ data: [] });
        liveEvents.mockResolvedValue([{
            id: '3815999',
            participant1: 'A. Kalinskaya',
            participant2: 'E. Navarro',
            league: 'US Open',
            score: '4-4',
            status: 'InPlay',
            points: '0-15',
            tourType: 'ATP',
            matchId: '32480-42098-16743-7',
        }]);

        const data = await handleHub(get('/api/hub?tour=ATP'), env);
        const row = data.todaysMatches.find(m => m.matchKey === '889');
        expect(row).toMatchObject({
            isLive: true,
            status: 'Live',
            setScores: ['4-4'],
            currentGame: '0 - 15',
        });
        expect(data.featuredMatch.matchKey).toBe('889');
        expect(data.featuredMatch.isLive).toBe(true);
        expect(data.featuredMatch.setScores).toEqual(['4-4']);
        expect(liveEvents).toHaveBeenCalled();
    });

    it('overlays livescore cache InPlay onto a cached hub first paint without a hub rewrite', async () => {
        const today = new Date().toISOString().slice(0, 10);
        calendar.mockResolvedValue({
            data: [{ id: 16743, name: 'U.S. Open', tier: 'Grand Slam', date: today }],
        });
        tournamentFixtures.mockResolvedValue({
            data: [{
                id: 889,
                player1Id: 32480,
                player2Id: 42098,
                player1: { name: 'Anna Kalinskaya' },
                player2: { name: 'Emma Navarro' },
                seed1: '21',
                seed2: '26',
                roundId: 7,
                date: today,
            }],
        });
        tournamentResults.mockResolvedValue({ data: { singles: [] } });
        h2h.mockResolvedValue({ data: [] });
        liveEvents.mockResolvedValue([]);

        const first = await handleHub(get('/api/hub?tour=ATP'), env);
        expect(first.todaysMatches[0].isLive).toBe(false);

        await cache.set(env, TTL.livescore, [{
            matchKey: '889',
            player1Key: '32480',
            player2Key: '42098',
            player1Name: 'Anna Kalinskaya',
            player2Name: 'Emma Navarro',
            isLive: true,
            status: 'Live',
            setScores: ['4-4'],
            currentGame: '0 - 15',
            roundId: 7,
            tournamentKey: '16743',
        }], 'livescore3', 'ATP', 'all', { skipStale: true });

        liveEvents.mockClear();
        const calendarCalls = calendar.mock.calls.length;
        const second = await handleHub(get('/api/hub?tour=ATP'), env);
        const row = second.todaysMatches.find(m => m.matchKey === '889');
        expect(row.isLive).toBe(true);
        expect(row.setScores).toEqual(['4-4']);
        expect(row.currentGame).toBe('0 - 15');
        expect(second.featuredMatch.isLive).toBe(true);
        expect(liveEvents).not.toHaveBeenCalled();
        expect(calendar.mock.calls.length).toBe(calendarCalls);
    });

    it('hub live overlay fails soft when MatchStat errors', async () => {
        seedHubUpstream();
        liveEvents.mockRejectedValue(new Error('Upstream request failed'));
        const data = await handleHub(get('/api/hub?tour=ATP'), env);
        expect(data.tournament).toMatchObject({ key: '99', name: 'Test Open' });
        expect(data.featuredMatch.player1Name).toBe('Ada');
        expect(data.featuredMatch.isLive).toBe(false);
    });

    it('still 400s junk tournamentKey when KV put throws (validation not fail-open)', async () => {
        env = mockEnv({ kvPutThrows: true });
        env.CORS_ORIGIN = '*';
        await expect(handleLivescore(get('/api/livescore?tournamentKey=abc'), env))
            .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/digits only/i) });
        const res = await worker.fetch(get('/api/livescore?tour=ITF'), env);
        expect(res.status).toBe(400);
        expect([...env.TENNIS_CACHE._store.keys()]).toEqual([]);
    });

    it('still 429s a full Cache API bucket when KV put throws (RL not fail-open, no KV RL write)', async () => {
        env = mockEnv({ kvPutThrows: true });
        env.CORS_ORIGIN = '*';
        await caches.default.put(rateLimitCacheUrl('livescore', '203.0.113.8'), new Response(
            JSON.stringify({ count: RL_PER_MINUTE.max, windowStart: Date.now() }),
            { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } },
        ));
        await expect(handleLivescore(get('/api/livescore?tour=ATP'), env))
            .rejects.toMatchObject({ status: 429, message: expect.stringMatching(/too many requests/i) });
        const res = await worker.fetch(get('/api/livescore?tour=ATP'), env);
        expect(res.status).toBe(429);
        expect([...env.TENNIS_CACHE._store.keys()]).toEqual([]);
    });
});
