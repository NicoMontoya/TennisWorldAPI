import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { QUOTA_FLAG_KEY } from '../quotaStop.js';
import { RL_PER_MINUTE, rateLimitCacheUrl } from '../security.js';
import {
    MAX_MATCHES_SCAN,
    MAX_ROSTER,
    MIN_MATCHES,
    SURFACE_FORM_TTL,
    WINDOW_DAYS,
    surfaceFormAsOf,
    windowCutoff,
} from './surfaceForm.js';

const PATH = '/api/rankings/surface-form';

function mockEnv(extra = {}) {
    const store = new Map();
    const gets = [];
    return {
        CORS_ORIGIN: '*',
        RAPIDAPI_KEY: 'test-rapid-key',
        RAPIDAPI_HARD_STOP: 'force',
        ...extra,
        gets,
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
                store.set(key, value);
            },
            async delete(key) { store.delete(key); },
            async list() {
                throw new Error('surface form must not list KV');
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
    globalThis.caches = {
        default: {
            async match(req) {
                const entry = store.get(urlOf(req));
                if (!entry) return undefined;
                return new Response(entry.body, { headers: entry.headers });
            },
            async put(req, res) {
                const headers = {};
                res.headers.forEach((v, k) => { headers[k] = v; });
                store.set(urlOf(req), { body: await res.clone().text(), headers });
            },
            async delete(req) {
                return store.delete(urlOf(req));
            },
            _store: store,
        },
    };
    return store;
}

function get(path, ip) {
    const headers = {};
    if (ip) headers['CF-Connecting-IP'] = ip;
    return new Request(`https://tennisworld-api.nicomontoya.workers.dev${path}`, { headers });
}

function seedEnvelope(env, key, data, stale = false) {
    env.TENNIS_CACHE._store.set(key, JSON.stringify({
        data,
        cachedAt: '2026-10-01T00:00:00.000Z',
        stale,
    }));
}

function seedStandings(env, tour, players) {
    seedEnvelope(env, `tw:standings2:${tour}`, players, false);
}

function seedStaleStandings(env, tour, players) {
    seedEnvelope(env, `tw:standings2:${tour}:stale`, players, true);
}

function seedLog(env, tour, playerKey, matches) {
    env.TENNIS_CACHE._store.set(
        `tw:matches:v1:${tour}:${playerKey}`,
        JSON.stringify(matches),
    );
}

function shift(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
}

function series(n, { date, won, surface }) {
    return Array.from({ length: n }, (_, i) => ({
        matchKey: `${surface}-${date}-${won ? 'W' : 'L'}-${i}`,
        date,
        surface,
        won,
        score: '6-4 6-4',
    }));
}

function standing(playerKey, name, extras = {}) {
    return {
        rank: extras.rank ?? 1,
        playerKey,
        name,
        country: extras.country ?? '',
        birthday: extras.birthday ?? null,
        points: 1000,
        tour: extras.tour ?? 'ATP',
    };
}

describe('GET /api/rankings/surface-form', () => {
    let env;
    let fetchMock;

    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        fetchMock = vi.fn(async () => {
            throw new Error('upstream fetch is not used by surface form');
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete globalThis.caches;
    });

    it('does not reference upstream clients or the other surface route', () => {
        const src = readFileSync(new URL('./surfaceForm.js', import.meta.url), 'utf8');
        expect(src).not.toMatch(/surface-standings/);
        expect(src).not.toMatch(/apiClient/);
        expect(src).not.toMatch(/rapidAPI/);
        expect(src).not.toMatch(/\bfetch\s*\(/);
    });

    it('rejects a bad or missing surface and a bad tour with 400 and no KV read', async () => {
        const paths = [
            `${PATH}?tour=ATP`,
            `${PATH}?tour=ATP&surface=`,
            `${PATH}?tour=ATP&surface=carpet`,
            `${PATH}?tour=ATP&surface=indoor`,
            `${PATH}?tour=ATP&surface=hardcourt`,
            `${PATH}?tour=ATP&surface=hard%20clay`,
            `${PATH}?tour=ITF&surface=clay`,
            `${PATH}?tour=atp-wta&surface=grass`,
        ];
        for (const path of paths) {
            env.gets.length = 0;
            const res = await worker.fetch(get(path), env);
            expect(res.status, path).toBe(400);
            const body = await res.json();
            expect(body.ok).toBe(false);
            expect(env.gets, path).toEqual([]);
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 400 for a bad surface even when the Cache API is down', async () => {
        delete globalThis.caches;
        const res = await worker.fetch(get(`${PATH}?tour=ATP&surface=carpet`), env);
        expect(res.status).toBe(400);
        expect(env.gets).toEqual([]);
    });

    it('fails closed with 429 when the Cache API is missing', async () => {
        delete globalThis.caches;
        const res = await worker.fetch(get(`${PATH}?tour=ATP&surface=clay`), env);
        expect(res.status).toBe(429);
        expect(env.gets).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ranks by win%, then matches played, then name, and omits short samples', async () => {
        const asOf = surfaceFormAsOf();
        const cutoff = windowCutoff(asOf);
        const before = shift(cutoff, -1);
        const future = shift(asOf, 1);
        const birthYear = Number(asOf.slice(0, 4)) - 22;

        seedStandings(env, 'ATP', [
            standing('201', 'Coco Gauff', { rank: 3, country: 'USA', birthday: `${birthYear}-01-01` }),
            standing('202', 'Iga Swiatek', { rank: 1, country: 'Poland', birthday: `${birthYear}-01-01` }),
            standing('203', 'Aryna Sabalenka', { rank: 2, country: 'Belarus' }),
            standing('204', 'Belinda Bencic', { rank: 10, country: 'Switzerland' }),
            standing('205', 'Anna Kalinskaya', { rank: 20 }),
            standing('206', 'Zoe Kruger', { rank: 21 }),
            standing('207', 'Short Sample', { rank: 30 }),
            standing('208', 'Old Clay', { rank: 31 }),
            standing('209', 'Hard Only', { rank: 32 }),
            standing('210', 'Future Pad', { rank: 33 }),
            standing('s999', 'Retired Legend', { rank: 4 }),
            standing('211', 'Beyond Scan', { rank: 40 }),
            standing('203', 'Wrong Duplicate', { rank: 50, country: 'Nowhere' }),
        ]);

        seedLog(env, 'ATP', '201', [
            ...series(9, { date: asOf, won: true, surface: 'clay' }),
            ...series(1, { date: asOf, won: false, surface: 'clay' }),
            ...series(12, { date: asOf, won: true, surface: 'hard' }),
        ]);
        seedLog(env, 'ATP', '202', [
            ...series(16, { date: asOf, won: true, surface: 'Clay' }),
            ...series(4, { date: asOf, won: false, surface: 'clay' }),
        ]);
        seedLog(env, 'ATP', '203', [
            ...series(8, { date: asOf, won: true, surface: 'clay' }),
            ...series(2, { date: asOf, won: false, surface: 'clay' }),
        ]);
        seedLog(env, 'ATP', '204', [
            ...series(8, { date: cutoff, won: true, surface: 'clay' }),
            ...series(2, { date: cutoff, won: false, surface: 'clay' }),
        ]);
        seedLog(env, 'ATP', '205', series(8, { date: asOf, won: true, surface: 'clay' }).map((m, i) => (
            i < 4 ? m : { ...m, won: false, matchKey: `clay-${asOf}-L-${i}` }
        )));
        seedLog(env, 'ATP', '206', [
            ...series(4, { date: asOf, won: true, surface: 'clay' }),
            ...series(4, { date: asOf, won: false, surface: 'clay' }),
        ]);
        seedLog(env, 'ATP', '207', series(MIN_MATCHES - 1, { date: asOf, won: true, surface: 'clay' }));
        seedLog(env, 'ATP', '208', series(10, { date: before, won: true, surface: 'clay' }));
        seedLog(env, 'ATP', '209', series(10, { date: asOf, won: true, surface: 'hard' }));
        seedLog(env, 'ATP', '210', [
            ...series(MIN_MATCHES - 1, { date: asOf, won: true, surface: 'clay' }),
            ...series(1, { date: future, won: true, surface: 'clay' }),
        ]);
        seedLog(env, 'ATP', 's999', series(20, { date: asOf, won: true, surface: 'clay' }));
        seedLog(env, 'ATP', '211', [
            ...series(MIN_MATCHES, { date: asOf, won: true, surface: 'clay' }),
            ...series(MAX_MATCHES_SCAN, { date: asOf, won: true, surface: 'hard' }),
        ]);

        const res = await worker.fetch(get(`${PATH}?tour=atp&surface=Clay&playerKey=201`), env);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.data).toMatchObject({
            tour: 'ATP',
            surface: 'clay',
            asOf,
            windowDays: WINDOW_DAYS,
            minMatches: MIN_MATCHES,
        });
        expect(body.data.reason).toBeUndefined();
        expect(body.data.rows.map(r => [r.rank, r.playerKey, r.name, r.w, r.l, r.winPct])).toEqual([
            [1, '201', 'Coco Gauff', 9, 1, 0.9],
            [2, '202', 'Iga Swiatek', 16, 4, 0.8],
            [3, '203', 'Aryna Sabalenka', 8, 2, 0.8],
            [4, '204', 'Belinda Bencic', 8, 2, 0.8],
            [5, '205', 'Anna Kalinskaya', 4, 4, 0.5],
            [6, '206', 'Zoe Kruger', 4, 4, 0.5],
        ]);
        expect(body.data.rows[0]).toMatchObject({ country: 'USA', age: 22 });
        expect(body.data.rows[2].country).toBe('Belarus');
        expect(body.data.rows.map(r => r.playerKey)).not.toContain('207');
        expect(body.data.rows.map(r => r.playerKey)).not.toContain('s999');
        expect(env.gets.some(k => k.includes('s999'))).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(env.gets.some(k => k === QUOTA_FLAG_KEY)).toBe(false);
        expect(WINDOW_DAYS).toBe(364);
    });

    it('serves an edge hit without reading KV again', async () => {
        const asOf = surfaceFormAsOf();
        seedStandings(env, 'ATP', [
            standing('301', 'Same Name', { rank: 2, country: 'Spain' }),
            standing('302', 'Same Name', { rank: 1, country: 'Italy' }),
        ]);
        seedLog(env, 'ATP', '301', series(8, { date: asOf, won: true, surface: 'grass' }));
        seedLog(env, 'ATP', '302', series(8, { date: asOf, won: true, surface: 'grass' }));

        const first = await worker.fetch(get(`${PATH}?tour=ATP&surface=grass`), env);
        const firstBody = await first.json();
        expect(firstBody.data.rows.map(r => r.playerKey)).toEqual(['301', '302']);
        const getsAfterFirst = env.gets.length;
        expect(getsAfterFirst).toBeGreaterThan(0);

        seedLog(env, 'ATP', '301', series(8, { date: asOf, won: false, surface: 'grass' }));
        seedLog(env, 'ATP', '302', series(20, { date: asOf, won: true, surface: 'grass' }));

        const second = await worker.fetch(get(`${PATH}?tour=ATP&surface=grass`), env);
        expect(second.status).toBe(200);
        const secondBody = await second.json();
        expect(secondBody).toEqual(firstBody);
        expect(env.gets.length).toBe(getsAfterFirst);
        expect(fetchMock).not.toHaveBeenCalled();

        const edgeKey = 'https://tennisworld-cache.internal/tw:surface-form-v1:ATP:grass';
        const cached = caches.default._store.get(edgeKey);
        const cacheControl = cached.headers['Cache-Control'] || cached.headers['cache-control'];
        expect(cacheControl).toBe(`public, max-age=${SURFACE_FORM_TTL}`);
    });

    it('does not reuse a clay board for hard', async () => {
        const asOf = surfaceFormAsOf();
        seedStandings(env, 'ATP', [standing('401', 'Clay Specialist', { rank: 1 })]);
        seedLog(env, 'ATP', '401', series(8, { date: asOf, won: true, surface: 'clay' }));

        const clay = await worker.fetch(get(`${PATH}?surface=clay`), env);
        expect((await clay.json()).data.rows).toHaveLength(1);

        const hard = await worker.fetch(get(`${PATH}?tour=ATP&surface=hard`), env);
        const hardBody = await hard.json();
        expect(hardBody.data.surface).toBe('hard');
        expect(hardBody.data.rows).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses the stale standings roster when the fresh key is missing', async () => {
        const asOf = surfaceFormAsOf();
        seedStaleStandings(env, 'WTA', [
            standing('501', 'Stale Roster', { rank: 1, country: 'USA', tour: 'WTA' }),
        ]);
        seedLog(env, 'WTA', '501', series(8, { date: asOf, won: true, surface: 'hard' }));

        const res = await worker.fetch(get(`${PATH}?tour=WTA&surface=hard`), env);
        const body = await res.json();
        expect(body.data.tour).toBe('WTA');
        expect(body.data.rows).toEqual([
            expect.objectContaining({ rank: 1, playerKey: '501', name: 'Stale Roster', w: 8, l: 0, winPct: 1 }),
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('prefers a fresh empty roster over the stale backup', async () => {
        const asOf = surfaceFormAsOf();
        seedStandings(env, 'ATP', []);
        seedStaleStandings(env, 'ATP', [standing('601', 'Stale Only', { rank: 1 })]);
        seedLog(env, 'ATP', '601', series(8, { date: asOf, won: true, surface: 'clay' }));

        const res = await worker.fetch(get(`${PATH}?tour=ATP&surface=clay`), env);
        const body = await res.json();
        expect(body.data.rows).toEqual([]);
        expect(body.data.reason).toBeUndefined();
        expect(env.gets.some(k => k.includes('601'))).toBe(false);
    });

    it('edge-caches a standings miss and does not call upstream', async () => {
        env = mockEnv({ RAPIDAPI_HARD_STOP: 'on' });
        const first = await worker.fetch(get(`${PATH}?tour=ATP&surface=clay`), env);
        const body = await first.json();
        expect(body.ok).toBe(true);
        expect(body.data.rows).toEqual([]);
        expect(body.data.reason).toBe('standings-not-loaded');
        const getsAfterFirst = env.gets.length;
        expect(env.gets.some(k => k === QUOTA_FLAG_KEY)).toBe(false);

        const second = await worker.fetch(get(`${PATH}?tour=ATP&surface=clay`), env);
        expect(await second.json()).toEqual(body);
        expect(env.gets.length).toBe(getsAfterFirst);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rounds winPct to four decimal places', async () => {
        const asOf = surfaceFormAsOf();
        seedStandings(env, 'ATP', [
            standing('701', 'Fraction', { rank: 1 }),
            standing('702', 'Winless', { rank: 2 }),
        ]);
        seedLog(env, 'ATP', '701', [
            ...series(2, { date: asOf, won: true, surface: 'grass' }),
            ...series(9, { date: asOf, won: false, surface: 'grass' }),
        ]);
        seedLog(env, 'ATP', '702', series(8, { date: asOf, won: false, surface: 'grass' }));

        const res = await worker.fetch(get(`${PATH}?tour=ATP&surface=grass`), env);
        const body = await res.json();
        expect(body.data.rows.map(r => [r.playerKey, r.w, r.l, r.winPct])).toEqual([
            ['701', 2, 9, 0.1818],
            ['702', 0, 8, 0],
        ]);
    });

    it('does not read match logs past the roster cap', async () => {
        const asOf = surfaceFormAsOf();
        const players = [];
        for (let rank = 1; rank <= MAX_ROSTER + 1; rank++) {
            players.push(standing(String(rank), `Player ${rank}`, { rank }));
        }
        players.push(standing('s1', 'Not A Digit', { rank: 1 }));
        seedStandings(env, 'ATP', players);
        const excluded = String(MAX_ROSTER + 1);
        seedLog(env, 'ATP', excluded, series(20, { date: asOf, won: true, surface: 'clay' }));
        seedLog(env, 'ATP', 's1', series(20, { date: asOf, won: true, surface: 'clay' }));

        const res = await worker.fetch(get(`${PATH}?tour=ATP&surface=clay`), env);
        const body = await res.json();
        expect(body.data.rows).toEqual([]);
        const logGets = env.gets.filter(k => k.startsWith('tw:matches:v1:'));
        expect(logGets).toHaveLength(MAX_ROSTER);
        expect(logGets).not.toContain(`tw:matches:v1:ATP:${excluded}`);
        expect(logGets).not.toContain('tw:matches:v1:ATP:s1');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 429 once the surface-form bucket is exhausted and does not read KV', async () => {
        const ip = '203.0.113.9';
        await caches.default.put(rateLimitCacheUrl('surface-form', ip), new Response(
            JSON.stringify({ count: RL_PER_MINUTE.max, windowStart: Date.now() }),
            { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } },
        ));
        const asOf = surfaceFormAsOf();
        seedStandings(env, 'ATP', [standing('801', 'Limited', { rank: 1 })]);
        seedLog(env, 'ATP', '801', series(8, { date: asOf, won: true, surface: 'clay' }));

        const res = await worker.fetch(get(`${PATH}?tour=ATP&surface=clay`, ip), env);
        expect(res.status).toBe(429);
        expect(await res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/too many requests/i) });
        expect(env.gets).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still builds the board when the hard stop is forced', async () => {
        expect(env.RAPIDAPI_HARD_STOP).toBe('force');
        const asOf = surfaceFormAsOf();
        seedStandings(env, 'ATP', [standing('901', 'Force Stop', { rank: 1, country: 'France' })]);
        seedLog(env, 'ATP', '901', [
            ...series(6, { date: asOf, won: true, surface: 'clay' }),
            ...series(2, { date: asOf, won: false, surface: 'clay' }),
        ]);

        const res = await worker.fetch(get(`${PATH}?tour=ATP&surface=clay`), env);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.rows).toEqual([
            expect.objectContaining({ playerKey: '901', w: 6, l: 2, winPct: 0.75 }),
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(env.gets.some(k => k === QUOTA_FLAG_KEY)).toBe(false);
    });
});
