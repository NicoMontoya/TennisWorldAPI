import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../index.js';
import { rankByAgeKey } from './vintageRankByAge.js';

function mockEnv() {
    const store = new Map();
    const puts = [];
    let gets = 0;
    return {
        ADMIN_SECRET: 'test-admin-secret',
        CORS_ORIGIN: '*',
        gets: () => gets,
        resetGets() { gets = 0; },
        TENNIS_CACHE: {
            async get(key, type) {
                gets++;
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
            async delete(key) { store.delete(key); },
            _store: store,
            _puts: puts,
        },
    };
}

function installMockCaches() {
    const store = new Map();
    globalThis.caches = {
        default: {
            async match(req) {
                const url = typeof req === 'string' ? req : req.url;
                const body = store.get(url);
                if (body === undefined) return undefined;
                return new Response(body, { headers: { 'Content-Type': 'application/json' } });
            },
            async put(req, res) {
                const url = typeof req === 'string' ? req : req.url;
                store.set(url, await res.text());
            },
            async delete(req) {
                const url = typeof req === 'string' ? req : req.url;
                return store.delete(url);
            },
        },
    };
    return store;
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

const fedYears = [
    { age: 22, rank: 1, weeksAtRank: 26.9, rankedWeeks: 52.3, partial: false },
    { age: 35, rank: 4, weeksAtRank: 9, rankedWeeks: 52.1, partial: false },
];

function fedRecord(years = fedYears) {
    return {
        name: 'Roger Federer',
        asOf: '2026-06-08',
        rankingsStart: '1973-08-27',
        ageAtRankingsStart: null,
        years,
    };
}

describe('GET /api/vintage-rank-by-age', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
    });
    afterEach(() => { delete globalThis.caches; });

    it('returns a stable not-available body for WTA without reading KV', async () => {
        const res = await worker.fetch(get('/api/vintage-rank-by-age?tour=wta&playerKey=s103819'), env);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            ok: true,
            data: {
                tour: 'WTA',
                playerKey: 's103819',
                name: null,
                asOf: null,
                rankingsStart: null,
                ageAtRankingsStart: null,
                available: false,
                reason: 'wta-ranking-history-not-loaded',
                years: [],
            },
        });
        expect(env.gets()).toBe(0);
        expect(env.TENNIS_CACHE._puts).toHaveLength(0);
    });

    it('401s the import, then serves ATP without a birthday or a sub-13 year', async () => {
        const denied = await worker.fetch(post('/api/admin/import-vintage-rank-by-age', {
            tour: 'ATP',
            records: { s103819: fedRecord() },
        }), env);
        expect(denied.status).toBe(401);

        const wta = await worker.fetch(post('/api/admin/import-vintage-rank-by-age', {
            tour: 'WTA',
            records: { s1: fedRecord() },
        }, { secret: env.ADMIN_SECRET }), env);
        expect(wta.status).toBe(400);

        const imported = await worker.fetch(post('/api/admin/import-vintage-rank-by-age', {
            tour: 'ATP',
            records: {
                S103819: {
                    ...fedRecord([
                        { age: 32, rank: 34, weeksAtRank: 2.9, rankedWeeks: 3.9, partial: false },
                        ...fedYears,
                    ]),
                    birthday: '1981-08-08',
                    dob: '19810808',
                },
                'not-a-key': fedRecord(),
            },
        }, { secret: env.ADMIN_SECRET }), env);
        expect(imported.status).toBe(200);
        expect((await imported.json()).data).toEqual({ ok: true, written: 1, skipped: 1, errors: 0 });

        const stored = JSON.parse(env.TENNIS_CACHE._store.get(rankByAgeKey('ATP', 's103819')));
        expect(stored.birthday).toBeUndefined();
        expect(stored.dob).toBeUndefined();
        expect(JSON.stringify(stored)).not.toContain('1981-08-08');
        expect(stored.years.map(y => y.age)).toEqual([22, 35]);
        const put = env.TENNIS_CACHE._puts.find(p => p.key === rankByAgeKey('ATP', 's103819'));
        expect(put.opts).toBeUndefined();

        env.resetGets();
        const res = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=S103819'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data).toEqual({
            tour: 'ATP',
            playerKey: 's103819',
            name: 'Roger Federer',
            asOf: '2026-06-08',
            rankingsStart: '1973-08-27',
            ageAtRankingsStart: null,
            available: true,
            years: fedYears,
        });
        expect(body.data.reason).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain('birthday');
        expect(env.gets()).toBe(1);

        env.resetGets();
        const again = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=s103819'), env);
        expect((await again.json()).data.years[0].rank).toBe(1);
        expect(env.gets()).toBe(0);
        expect(env.TENNIS_CACHE._puts.filter(p => p.key.includes(':stale'))).toHaveLength(0);
    });

    it('replaces an edge hit when the admin import overwrites the record', async () => {
        await worker.fetch(post('/api/admin/import-vintage-rank-by-age', {
            tour: 'ATP',
            records: { s103819: fedRecord() },
        }, { secret: env.ADMIN_SECRET }), env);
        await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=s103819'), env);

        await worker.fetch(post('/api/admin/import-vintage-rank-by-age', {
            tour: 'ATP',
            records: {
                s103819: fedRecord([
                    { age: 22, rank: 2, weeksAtRank: 30, rankedWeeks: 52, partial: true },
                ]),
            },
        }, { secret: env.ADMIN_SECRET }), env);

        const res = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=s103819'), env);
        expect((await res.json()).data.years).toEqual([
            { age: 22, rank: 2, weeksAtRank: 30, rankedWeeks: 52, partial: true },
        ]);
    });

    it('says not-loaded when the calendar exists and rankings-not-loaded when it does not', async () => {
        const empty = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=47275'), env);
        expect((await empty.json()).data).toMatchObject({
            available: false,
            reason: 'rankings-not-loaded',
            asOf: null,
            years: [],
        });

        env.TENNIS_CACHE._store.set('tw:rankings-history-index:v1:ATP', JSON.stringify({
            min: '1973-08-27',
            max: '2026-06-08',
            dates: ['1973-08-27', '2026-06-08'],
        }));
        const missing = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=47275'), env);
        expect((await missing.json()).data).toMatchObject({
            available: false,
            reason: 'not-loaded',
            asOf: '2026-06-08',
            rankingsStart: '1973-08-27',
            years: [],
        });
    });

    it('returns no-birthday and no-ranking-history without inventing a rank', async () => {
        await worker.fetch(post('/api/admin/import-vintage-rank-by-age', {
            tour: 'ATP',
            records: {
                s101948: { name: 'Pete Sampras', asOf: '2026-06-08', rankingsStart: '1973-08-27', ageAtRankingsStart: 2, years: [], reason: 'no-birthday' },
                s101736: { name: 'Andre Agassi', asOf: '2026-06-08', rankingsStart: '1973-08-27', ageAtRankingsStart: 3, years: [], reason: 'no-ranking-history' },
            },
        }, { secret: env.ADMIN_SECRET }), env);

        const sam = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=s101948'), env);
        expect((await sam.json()).data).toMatchObject({
            available: true,
            reason: 'no-birthday',
            name: 'Pete Sampras',
            ageAtRankingsStart: 2,
            years: [],
        });
        const aga = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=s101736'), env);
        expect((await aga.json()).data).toMatchObject({
            available: true,
            reason: 'no-ranking-history',
            years: [],
        });
    });

    it('strips a birthday that was written straight into KV', async () => {
        env.TENNIS_CACHE._store.set(rankByAgeKey('ATP', 's101736'), JSON.stringify({
            name: 'Andre Agassi',
            birthday: '1970-04-29',
            asOf: '2026-06-08',
            rankingsStart: '1973-08-27',
            ageAtRankingsStart: 3,
            years: [{ age: 25, rank: 1, weeksAtRank: 29.3, rankedWeeks: 52.3, partial: false }],
        }));
        const res = await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=s101736'), env);
        const text = await res.text();
        expect(text).not.toContain('1970-04-29');
        expect(text).not.toContain('birthday');
        expect(JSON.parse(text).data.years[0].rank).toBe(1);
    });

    it('rejects a missing or junk playerKey and an unknown tour', async () => {
        expect((await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP'), env)).status).toBe(400);
        expect((await worker.fetch(get('/api/vintage-rank-by-age?tour=ATP&playerKey=sampras'), env)).status).toBe(400);
        expect((await worker.fetch(get('/api/vintage-rank-by-age?tour=ITF&playerKey=s1'), env)).status).toBe(400);
    });
});
