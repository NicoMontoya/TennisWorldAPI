import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { createMemoryD1 } from '../d1Memory.js';
import { rememberDraw, rememberFixtures, rememberStandings, rememberTournaments } from '../d1Store.js';
import { handleCalendar } from './calendar.js';
import { handleDraws } from './draws.js';
import { handleFixtures } from './fixtures.js';
import { handleStandings } from './standings.js';
import { QuotaStopError } from '../quotaStop.js';
import { readAsOf } from '../asOf.js';

const fixturesFeed = vi.fn();
const tournamentFixtures = vi.fn();
const tournamentResults = vi.fn();
const tournamentInfo = vi.fn();
const rankingsPaged = vi.fn();
const rankings = vi.fn();
const calendar = vi.fn();
const calendarPage = vi.fn();

vi.mock('../apiClient.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        rapidAPI: {
            ...orig.rapidAPI,
            fixturesFeed: (...args) => fixturesFeed(...args),
            tournamentFixtures: (...args) => tournamentFixtures(...args),
            tournamentResults: (...args) => tournamentResults(...args),
            tournamentInfo: (...args) => tournamentInfo(...args),
            rankingsPaged: (...args) => rankingsPaged(...args),
            rankings: (...args) => rankings(...args),
            calendar: (...args) => calendar(...args),
            calendarPage: (...args) => calendarPage(...args),
        },
    };
});

function cacheEnv(extra = {}) {
    const store = new Map();
    return {
        CORS_ORIGIN: '*',
        ADMIN_SECRET: 'test-admin-secret',
        D1_DAILY_WRITE_BUDGET: '20000',
        D1_BACKFILL_BATCH: '40',
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

const rapidMatch = {
    id: 88001,
    date: '2026-11-05T14:30:00.000Z',
    roundId: 9,
    tournament: { id: 16745, name: 'Metz' },
    player1Id: 2072,
    player2Id: 2315,
    player1: { id: 2072, name: 'J. Sinner' },
    player2: { id: 2315, name: 'C. Alcaraz' },
};

describe('phase 0 fixtures + last-good', () => {
    let env;
    beforeEach(() => {
        env = cacheEnv();
        fixturesFeed.mockReset();
        tournamentFixtures.mockReset();
        tournamentResults.mockReset();
        tournamentInfo.mockReset();
        rankingsPaged.mockReset();
        rankings.mockReset();
        calendar.mockReset();
        calendarPage.mockReset();
    });
    afterEach(() => { delete globalThis.caches; });

    it('GET /api/fixtures?tour=atp fills keys from the RapidAPI envelope and drops a blank row', async () => {
        fixturesFeed.mockResolvedValue({
            data: [rapidMatch, { player1: { name: 'Ghost' } }],
            hasNextPage: false,
        });
        const rows = await handleFixtures(new Request('https://example.test/api/fixtures?tour=atp'), env);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            matchKey: '88001',
            tournamentKey: '16745',
            tournamentName: 'Metz',
            date: '2026-11-05',
            time: '14:30',
            status: 'Not Started',
            round: 'Quarter-finals',
            player1Name: 'J. Sinner',
            player2Name: 'C. Alcaraz',
        });
        expect(readAsOf(rows)).toBeUndefined();
        expect(env.DB._tables.fixtures).toHaveLength(1);
        expect(env.DB._tables.fixtures[0].match_key).toBe('88001');

        const res = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.asOf).toBeUndefined();
        expect(body.data[0].matchKey).toBe('88001');
    });

    it('serves the stored fixtures with asOf when the hard stop blocks the pull, and [] when nothing was stored', async () => {
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
        fixturesFeed.mockRejectedValue(new QuotaStopError());

        const res = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.data).toEqual([expect.objectContaining({ matchKey: '42', tournamentName: 'Paris' })]);
        expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(body.data[0].asOf).toBeUndefined();

        const emptyEnv = cacheEnv();
        fixturesFeed.mockRejectedValue(new QuotaStopError());
        const empty = await worker.fetch(new Request('https://example.test/api/fixtures?tour=WTA'), emptyEnv);
        const emptyBody = await empty.json();
        expect(emptyBody).toEqual({ ok: true, data: [] });
    });

    it('serves a stored calendar and draw when upstream fails', async () => {
        const today = new Date().toISOString().slice(0, 10);
        await rememberTournaments(env, 'ATP', [{
            id: 42,
            name: 'Test Open',
            tier: 'ATP 250',
            date: `${today}T00:00:00.000Z`,
            court: { name: 'Clay' },
            coutry: { name: 'France', acronym: 'FRA' },
            draw_size: 28,
        }], { replace: true });
        calendar.mockRejectedValue(new QuotaStopError());
        const cal = await worker.fetch(
            new Request(`https://example.test/api/calendar?tour=ATP&dateStart=${today}&dateStop=${today}`),
            env,
        );
        const calBody = await cal.json();
        expect(cal.status).toBe(200);
        expect(calBody.data[0]).toMatchObject({ tournamentKey: '42', name: 'Test Open' });
        expect(calBody.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        await rememberDraw(env, 'ATP', '9001', {
            tournamentKey: '9001',
            name: 'Stored Open',
            totalMatches: 0,
            rounds: [],
        });
        tournamentResults.mockRejectedValue(new QuotaStopError());
        tournamentFixtures.mockResolvedValue({ data: [] });
        tournamentInfo.mockResolvedValue({ data: { name: 'Nope' } });
        const draw = await handleDraws(new Request('https://example.test/api/draws?tournamentKey=9001&tour=ATP'), env);
        expect(draw.name).toBe('Stored Open');
        expect(readAsOf(draw)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const bare = cacheEnv();
        tournamentResults.mockRejectedValue(new QuotaStopError());
        const missing = await handleDraws(new Request('https://example.test/api/draws?tournamentKey=9001&tour=ATP'), bare);
        expect(missing).toEqual({ tournamentKey: '9001', name: '', totalMatches: 0, rounds: [] });
        expect(readAsOf(missing)).toBeUndefined();
    });

    it('serves stored standings when the rankings pull fails', async () => {
        await rememberStandings(env, 'ATP', [
            { playerKey: '5', rank: 1, name: 'Stored', points: 10, tour: 'ATP' },
        ], { replace: true });
        rankingsPaged.mockRejectedValue(new QuotaStopError());
        const rows = await handleStandings(new Request('https://example.test/api/standings?tour=ATP'), env);
        expect(rows).toEqual([expect.objectContaining({ playerKey: '5', name: 'Stored' })]);
        expect(readAsOf(rows)).toBeTruthy();
    });

    it('rejects a bad fixtures date before calling upstream', async () => {
        await expect(handleFixtures(new Request('https://example.test/api/fixtures?dateStart=../../x'), env))
            .rejects.toMatchObject({ status: 400 });
        expect(fixturesFeed).not.toHaveBeenCalled();
    });
});

describe('import and backfill auth', () => {
    afterEach(() => { delete globalThis.caches; });

    it('is POST-only and 401 without x-admin-secret, including when the secret is unset or only in the query', async () => {
        const env = cacheEnv();
        const getRes = await worker.fetch(new Request('https://example.test/api/admin/backfill-rankings?secret=test-admin-secret'), env);
        expect(getRes.status).toBe(404);

        const noHeader = await worker.fetch(new Request('https://example.test/api/admin/backfill-last-good', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource: 'fixtures', tour: 'ATP' }),
        }), env);
        expect(noHeader.status).toBe(401);
        expect(await noHeader.json()).toEqual({ ok: false, error: 'Unauthorized' });

        const queryOnly = await worker.fetch(new Request('https://example.test/api/admin/backfill-rankings?secret=test-admin-secret', {
            method: 'POST',
        }), env);
        expect(queryOnly.status).toBe(401);

        const closed = cacheEnv({ ADMIN_SECRET: '' });
        const withHeader = await worker.fetch(new Request('https://example.test/api/admin/backfill-last-good', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-secret': 'test-admin-secret' },
            body: JSON.stringify({ resource: 'fixtures', tour: 'ATP' }),
        }), closed);
        expect(withHeader.status).toBe(401);
        expect(fixturesFeed).not.toHaveBeenCalled();
    });

    it('writes one capped fixtures batch and reports the next page', async () => {
        const env = cacheEnv({ D1_BACKFILL_BATCH: '2' });
        fixturesFeed.mockResolvedValue({
            data: [
                rapidMatch,
                { ...rapidMatch, id: 88002, player1: { id: 1, name: 'A' }, player2: { id: 2, name: 'B' } },
                { ...rapidMatch, id: 88003, player1: { id: 3, name: 'C' }, player2: { id: 4, name: 'D' } },
            ],
            hasNextPage: true,
        });
        const res = await worker.fetch(new Request('https://example.test/api/admin/backfill-last-good', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-secret': 'test-admin-secret' },
            body: JSON.stringify({ resource: 'fixtures', tour: 'ATP', page: 1 }),
        }), env);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data).toMatchObject({
            ok: true,
            resource: 'fixtures',
            written: 2,
            capped: true,
            nextPage: 2,
        });
        expect(env.DB._tables.fixtures).toHaveLength(2);
        expect(fixturesFeed).toHaveBeenCalledWith(env, 'ATP', { pageNo: 1, pageSize: 2 });
    });
});

describe('calendar helper stays quiet', () => {
    it('does not throw when building a week from stored rows', async () => {
        const env = cacheEnv();
        calendar.mockRejectedValue(new Error('nope'));
        const rows = await handleCalendar(new Request('https://example.test/api/calendar?tour=ATP&dateStart=2026-01-01&dateStop=2026-01-07'), env);
        expect(rows).toEqual([]);
    });
});
