import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { isLegendId, normalizeLegendId } from './vintage.js';

const rankings = vi.fn();
vi.mock('../apiClient.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        rapidAPI: {
            ...orig.rapidAPI,
            rankings: (...args) => rankings(...args),
        },
    };
});

function mockEnv() {
    const store = new Map();
    const puts = [];
    return {
        ADMIN_SECRET: 'test-admin-secret',
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
                puts.push({ key, opts });
                store.set(key, value);
            },
            async delete(key) {
                store.delete(key);
            },
            _store: store,
            _puts: puts,
        },
    };
}

function installMockCaches() {
    const store = new Map();
    globalThis.caches = {
        default: {
            async match() { return undefined; },
            async put() {},
            async delete() { return true; },
            _store: store,
        },
    };
}

function get(path) {
    return new Request(`https://tennisworld-api.nicomontoya.workers.dev${path}`);
}

function post(path, body, { secret } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['x-admin-secret'] = secret;
    return new Request(`https://tennisworld-api.nicomontoya.workers.dev${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

describe('Sackmann legend id polish', () => {
    it('accepts s+digits and normalizes case', () => {
        expect(isLegendId('s103819')).toBe(true);
        expect(normalizeLegendId('S103819')).toBe('s103819');
        expect(normalizeLegendId('  s101948  ')).toBe('s101948');
    });

    it('rejects names and RapidAPI numeric keys', () => {
        expect(isLegendId('sampras')).toBe(false);
        expect(isLegendId('s')).toBe(false);
        expect(isLegendId('47275')).toBe(false);
        expect(normalizeLegendId('s-103819')).toBeNull();
    });
});

describe('backfill → KV → public GET (worker contract)', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
    });
    afterEach(() => { delete globalThis.caches; });

    it('rankings-history: empty is 404; import persists without TTL; GET serves the week', async () => {
        const empty = await worker.fetch(get('/api/rankings-history?tour=ATP&meta=1'), env);
        expect(empty.status).toBe(404);
        expect(await empty.json()).toMatchObject({ ok: false, error: expect.stringMatching(/No historical rankings/i) });

        const denied = await worker.fetch(post('/api/admin/import-rankings-history', {
            tour: 'ATP', year: '2001', snapshots: { '2001-07-09': [{ rank: 1, name: 'Goran Ivanisevic', country: 'CRO', points: 0, pid: '101414' }] },
        }), env);
        expect(denied.status).toBe(401);

        const imported = await worker.fetch(post('/api/admin/import-rankings-history', {
            tour: 'ATP',
            year: '2001',
            snapshots: {
                '2001-07-09': [{ rank: 1, name: 'Goran Ivanisevic', country: 'CRO', points: 4110, pid: '101414' }],
            },
            indexDates: ['2001-07-09'],
        }, { secret: env.ADMIN_SECRET }), env);
        expect(imported.status).toBe(200);
        const importedBody = await imported.json();
        expect(importedBody).toMatchObject({ ok: true, data: { ok: true, year: '2001', weeks: 1, indexUpdated: true } });

        const yearPut = env.TENNIS_CACHE._puts.find(p => p.key === 'tw:rankings-history:v1:ATP:2001');
        expect(yearPut).toBeTruthy();
        expect(yearPut.opts).toBeUndefined();

        const meta = await worker.fetch(get('/api/rankings-history?tour=ATP&meta=1'), env);
        expect(meta.status).toBe(200);
        expect(await meta.json()).toMatchObject({
            ok: true,
            data: { tour: 'ATP', min: '2001-07-09', max: '2001-07-09', count: 1 },
        });

        const week = await worker.fetch(get('/api/rankings-history?tour=ATP&date=2001-07-10&limit=10'), env);
        const weekBody = await week.json();
        expect(week.status).toBe(200);
        expect(weekBody.data.date).toBe('2001-07-09');
        expect(weekBody.data.rankings[0]).toMatchObject({ rank: 1, name: 'Goran Ivanisevic', pid: '101414' });
    });

    it('rankings-history: intermediate years can skip the index write', async () => {
        const mid = await worker.fetch(post('/api/admin/import-rankings-history', {
            tour: 'ATP',
            year: '1985',
            snapshots: { '1985-01-07': [{ rank: 1, name: 'John McEnroe', country: 'USA', points: null, pid: '100284' }] },
            updateIndex: false,
        }, { secret: env.ADMIN_SECRET }), env);
        expect((await mid.json()).data).toMatchObject({ indexUpdated: false, totalDates: null });
        expect(env.TENNIS_CACHE._store.has('tw:rankings-history:v1:ATP:1985')).toBe(true);
        expect(env.TENNIS_CACHE._store.has('tw:rankings-history-index:v1:ATP')).toBe(false);
    });

    it('player rank history: import then GET returns the career arc', async () => {
        const imported = await worker.fetch(post('/api/admin/import-rank-history', {
            tour: 'ATP',
            histories: {
                '47275': [
                    { date: '2018-01-01', rank: 550 },
                    { date: '2026-09-07', rank: 1 },
                ],
            },
        }, { secret: env.ADMIN_SECRET }), env);
        expect(imported.status).toBe(200);
        expect((await imported.json()).data).toMatchObject({ ok: true, written: 1, errors: 0 });

        const got = await worker.fetch(get('/api/player-ranking-history?tour=ATP&playerKey=47275'), env);
        const body = await got.json();
        expect(got.status).toBe(200);
        expect(body.data.history).toEqual([
            { date: '2018-01-01', rank: 550 },
            { date: '2026-09-07', rank: 1 },
        ]);
    });

    it('vintage legends: s-key import persists without TTL and GET serves the curve', async () => {
        const curve = {
            player: { id: 's103819', name: 'Roger Federer', countryAcr: 'SUI', birthday: '1981-08-08', legend: true },
            points: [{ age: 17.2, w: 1, m: 1, t: 0, ms: 0, gs: 0 }],
            totals: { wins: 1251, matches: 1526, titles: 103, masters: 28, slams: 20 },
        };

        const denied = await worker.fetch(post('/api/admin/import-vintage', {
            tour: 'ATP', curves: { s103819: curve },
        }), env);
        expect(denied.status).toBe(401);

        const imported = await worker.fetch(post('/api/admin/import-vintage', {
            tour: 'ATP',
            curves: { s103819: curve, sampras: curve },
            legends: [
                { id: 'S103819', name: 'Roger Federer', countryAcr: 'SUI', wins: 1251 },
                { id: 'not-a-legend', name: 'Skip Me', countryAcr: 'XXX', wins: 1 },
            ],
        }, { secret: env.ADMIN_SECRET }), env);
        const importedBody = await imported.json();
        expect(imported.status).toBe(200);
        expect(importedBody.data).toMatchObject({ ok: true, written: 1, skipped: 1, legends: 2 });

        const curvePut = env.TENNIS_CACHE._puts.find(p => p.key === 'tw:vintage:v1:ATP:s103819');
        expect(curvePut).toBeTruthy();
        expect(curvePut.opts).toBeUndefined();

        const missing = await worker.fetch(get('/api/player-vintage?tour=ATP&playerKey=s101948'), env);
        expect((await missing.json()).data).toMatchObject({
            error: 'not-loaded',
            player: { id: 's101948', legend: true },
        });

        const fed = await worker.fetch(get('/api/player-vintage?tour=ATP&playerKey=S103819'), env);
        const fedBody = await fed.json();
        expect(fed.status).toBe(200);
        expect(fedBody.data.player.name).toBe('Roger Federer');
        expect(fedBody.data.totals.slams).toBe(20);

        rankings.mockResolvedValue({
            data: [{ position: 1, player: { id: 47275, name: 'Jannik Sinner', countryAcr: 'ITA' } }],
        });
        const roster = await worker.fetch(get('/api/vintage-roster?tour=ATP'), env);
        const rosterBody = await roster.json();
        expect(rosterBody.data.roster[0]).toMatchObject({ id: '47275', name: 'Jannik Sinner' });
        expect(rosterBody.data.roster.some(r => r.id === 's103819' && r.legend)).toBe(true);
        expect(rosterBody.data.roster.some(r => r.id === 'not-a-legend')).toBe(false);
    });
});
