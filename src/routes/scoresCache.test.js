import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TTL } from '../config.js';
import { cache } from '../cache.js';
import { handleLivescore } from './livescore.js';
import { handleHub } from './hub.js';
import worker from '../index.js';

const calendar = vi.fn();
const tournamentResults = vi.fn();
const tournamentFixtures = vi.fn();
const h2h = vi.fn();

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
        },
    };
});

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
            'livescore2',
            'ATP',
            'all',
            { skipStale: true },
        );
        const kvKeys = [...env.TENNIS_CACHE._store.keys()];
        expect(kvKeys).toContain('tw:livescore2:ATP:all');
        expect(kvKeys.some(k => k.endsWith(':stale'))).toBe(false);
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
});
