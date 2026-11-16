import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../index.js';
import { createMemoryD1 } from '../d1Memory.js';
import { rememberFixtures, rememberStandings } from '../d1Store.js';
import { resetFixtureStatusMemoryForTests } from './fixtures.js';
import { setPicksNowForTests } from '../picksClock.js';
import { UPSERT_PICK_SQL } from '../picksStore.js';

const ORIGIN = 'https://example.test';
const SECRET = 'test-admin-secret';

function mockEnv() {
    const store = new Map();
    return {
        CORS_ORIGIN: ORIGIN,
        ADMIN_SECRET: SECRET,
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
            async put(key, value) { store.set(key, String(value)); },
            async delete(key) { store.delete(key); },
            _store: store,
        },
    };
}

function installMockCaches() {
    const store = new Map();
    const cache = {
        async match(req) {
            const url = typeof req === 'string' ? req : req.url;
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
    };
    globalThis.caches = { default: cache };
    return cache;
}

function call(path, { method = 'GET', body, cookie, ip, secret, origin, contentType } = {}) {
    const url = `${ORIGIN}${path}`;
    const headers = {};
    if (method === 'POST') {
        if (origin !== null) headers.Origin = origin || new URL(url).origin;
        if (contentType !== null) headers['Content-Type'] = contentType || 'application/json';
    }
    if (cookie) headers.Cookie = cookie;
    if (ip) headers['CF-Connecting-IP'] = ip;
    if (secret) headers['x-admin-secret'] = secret === true ? SECRET : secret;
    return new Request(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body === undefined ? {} : body) : undefined,
    });
}

function cookiePair(response) {
    const lines = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    const line = lines.find(value => value && value.startsWith('__Host-tw_session=')) || '';
    return line.split(';')[0];
}

async function issue(env) {
    const res = await worker.fetch(call('/api/admin/invites', { method: 'POST', secret: true, body: {} }), env);
    expect(res.status).toBe(200);
    return (await res.json()).data.code;
}

async function register(env, { email, displayName, ip }) {
    const inviteCode = await issue(env);
    const res = await worker.fetch(call('/api/auth/register', {
        method: 'POST',
        ip,
        body: { firstName: 'Ada', lastName: 'Lovelace', password: 'secret1', email, displayName, inviteCode },
    }), env);
    expect(res.status, email).toBe(200);
    return cookiePair(res);
}

function keysDeep(value, out = []) {
    if (Array.isArray(value)) value.forEach(item => keysDeep(item, out));
    else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            out.push(key);
            keysDeep(child, out);
        }
    }
    return out;
}

function fixture(overrides = {}) {
    return {
        matchKey: 'm1',
        tournamentKey: '900',
        tournamentName: 'Nitto ATP Finals',
        tier: 'tour',
        eventType: 'ATP Singles',
        date: '2026-11-18',
        time: '19:00',
        startsAtUtc: '2026-11-18T18:00:00.000Z',
        status: 'Not Started',
        round: 'Round Robin',
        roundId: 1,
        player1Key: '10',
        player1Name: 'Alcaraz',
        player2Key: '11',
        player2Name: 'Sinner',
        winner: '',
        setScores: [],
        ...overrides,
    };
}

async function seed(env, rows) {
    await rememberFixtures(env, 'ATP', rows);
}

function putLivescore(env, rows, cachedAt = '2026-11-16T12:00:00.000Z') {
    env.TENNIS_CACHE._store.set('tw:livescore3:ATP:all', JSON.stringify({
        data: rows,
        cachedAt,
    }));
}

function live(overrides = {}) {
    return {
        matchKey: 'm1',
        player1Key: '10',
        player2Key: '11',
        tournamentKey: '900',
        roundId: 1,
        status: 'Finished',
        statusText: 'Finished',
        winner: '10',
        setScores: ['6-4', '6-3'],
        ...overrides,
    };
}

describe('picks API', () => {
    let env;
    let now;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
        now = Date.parse('2026-11-16T12:00:00.000Z');
        setPicksNowForTests(() => now);
        resetFixtureStatusMemoryForTests();
    });
    afterEach(() => {
        setPicksNowForTests();
        resetFixtureStatusMemoryForTests();
        delete globalThis.caches;
    });

    async function member(email = 'secret-ada@example.test', displayName = 'Ada P', ip = '203.0.113.10') {
        return register(env, { email, displayName, ip });
    }

    async function postPick(cookie, body, ip = '203.0.113.10') {
        return worker.fetch(call('/api/picks', { method: 'POST', cookie, body, ip }), env);
    }

    it('the pick upsert checks locked_at and lock_at inside one statement', async () => {
        expect(UPSERT_PICK_SQL).toMatch(/ON CONFLICT\(member_id, match_key\)/);
        expect(UPSERT_PICK_SQL).toMatch(/picks\.locked_at IS NULL/);
        expect(UPSERT_PICK_SQL).toMatch(/excluded\.lock_at > \?/);
        expect(UPSERT_PICK_SQL).toMatch(/picks\.lock_at > \?/);
        expect(UPSERT_PICK_SQL).not.toMatch(/SELECT[\s\S]+FROM picks[\s\S]+UPDATE/i);

        const future = Date.parse('2026-11-18T18:00:00.000Z');
        await env.DB.prepare(UPSERT_PICK_SQL).bind(
            'secret-ada@example.test', 'm1', '10', now, now, future, 'ATP', future, now, now, now,
        ).run();
        env.DB._tables.picks[0].locked_at = now;
        const blocked = await env.DB.prepare(UPSERT_PICK_SQL).bind(
            'secret-ada@example.test', 'm1', '11', now, now + 5, future, 'ATP', future, now, now, now,
        ).run();
        expect(blocked.meta.changes).toBe(0);
        expect(env.DB._tables.picks[0].picked_player_key).toBe('10');

        env.DB._tables.picks[0].locked_at = null;
        env.DB._tables.picks[0].lock_at = now - 1;
        const expired = await env.DB.prepare(UPSERT_PICK_SQL).bind(
            'secret-ada@example.test', 'm1', '11', now, now + 5, future + 86_400_000, 'ATP',
            future + 86_400_000, now, now, now,
        ).run();
        expect(expired.meta.changes).toBe(0);
        expect(env.DB._tables.picks[0].picked_player_key).toBe('10');
    });

    it('refuses a pick inside the same D1 statement when the match is Live, Delayed, Finished, Walkover, or Cancelled', async () => {
        const cookie = await member();
        const statuses = ['Live', 'Delayed', 'Finished', 'Walkover', 'Cancelled'];
        await seed(env, [
            fixture(),
            ...statuses.map(status => fixture({ matchKey: status.toLowerCase() })),
        ]);
        const first = await postPick(cookie, {
            matchKey: 'm1', playerKey: '10', now: 1, created_at: 1, rank_gap: 99, points: 5,
        });
        expect(first.status).toBe(200);
        putLivescore(env, [
            live({ status: 'Live', statusText: 'Live', winner: '', setScores: [] }),
            ...statuses.map(status => live({
                matchKey: status.toLowerCase(),
                status,
                statusText: status,
                winner: status === 'Finished' ? '10' : '',
                setScores: status === 'Finished' ? ['6-4', '6-3'] : [],
            })),
        ]);
        const changed = await postPick(cookie, { matchKey: 'm1', playerKey: '11' });
        expect(changed.status).toBe(409);
        expect(await changed.json()).toEqual({ ok: false, error: 'That match is locked.' });
        expect(env.DB._tables.picks).toHaveLength(1);
        expect(env.DB._tables.picks[0].picked_player_key).toBe('10');
        expect(env.DB._tables.picks[0].locked_at).toBe(now);
        for (const status of statuses) {
            const res = await postPick(cookie, { matchKey: status.toLowerCase(), playerKey: '10' });
            expect(res.status, status).toBe(409);
            expect(await res.json()).toEqual({ ok: false, error: 'That match is locked.' });
        }
        expect(env.DB._tables.picks).toHaveLength(1);
    });

    it('refuses a pick inside the same D1 statement after startsAtUtc', async () => {
        const cookie = await member();
        await seed(env, [fixture({ startsAtUtc: '2026-11-16T18:00:00.000Z' })]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        now = Date.parse('2026-11-16T18:00:00.000Z');
        const payload = JSON.parse(env.DB._tables.fixtures[0].payload);
        payload.startsAtUtc = '';
        payload.time = '';
        env.DB._tables.fixtures[0].payload = JSON.stringify(payload);
        env.DB._tables.fixtures[0].starts_at_utc = '';
        const res = await postPick(cookie, { matchKey: 'm1', playerKey: '11', now: now + 86_400_000 });
        expect(res.status).toBe(409);
        expect(env.DB._tables.picks[0].picked_player_key).toBe('10');
        expect(env.DB._tables.picks[0].locked_at).toBe(now);
    });

    it('locks an untimed match at the start of the match date, including a stale Not Started cache', async () => {
        const cookie = await member();
        const untimed = (matchKey, extra = {}) => fixture({
            matchKey,
            startsAtUtc: '',
            time: '',
            date: '2026-11-16',
            timeZone: '',
            ...extra,
        });
        await seed(env, [
            untimed('dayof'),
            untimed('stale'),
            untimed('early'),
            untimed('nodate', { date: '' }),
            untimed('vienna', {
                tournamentName: 'Vienna',
                tier: 'tour',
                player1Key: '50',
                player2Key: '51',
            }),
        ]);
        now = Date.parse('2026-11-16T12:00:00.000Z');
        const empty = await postPick(cookie, { matchKey: 'dayof', playerKey: '10' });
        expect(empty.status).toBe(409);
        expect(await empty.json()).toEqual({ ok: false, error: 'That match is locked.' });
        putLivescore(env, [live({
            matchKey: 'stale',
            status: 'Not Started',
            statusText: 'Not Started',
            winner: '',
            setScores: [],
        })], '2026-11-15T08:00:00.000Z');
        const stale = await postPick(cookie, { matchKey: 'stale', playerKey: '10' });
        expect(stale.status).toBe(409);
        expect(env.DB._tables.picks.filter(row => row.match_key === 'dayof' || row.match_key === 'stale')).toHaveLength(0);

        now = Date.parse('2026-11-15T12:00:00.000Z');
        const opened = await worker.fetch(call('/api/picks/open', { cookie }), env);
        const earlyCard = (await opened.json()).data.matches.find(match => match.matchKey === 'early');
        expect(earlyCard.lockKind).toBe('day_start');
        expect(earlyCard.locksAtUtc).toBe('2026-11-15T23:00:00.000Z');
        expect((await postPick(cookie, { matchKey: 'early', playerKey: '10' })).status).toBe(200);
        const missing = await postPick(cookie, { matchKey: 'nodate', playerKey: '10' });
        expect(missing.status).toBe(400);

        now = Date.parse('2026-11-15T23:30:00.000Z');
        expect((await postPick(cookie, { matchKey: 'early', playerKey: '11' })).status).toBe(409);
        const vienna = await postPick(cookie, { matchKey: 'vienna', playerKey: '50' });
        expect(vienna.status).toBe(200);
        expect(env.DB._tables.picks.find(row => row.match_key === 'vienna').lock_at)
            .toBe(Date.parse('2026-11-16T00:00:00.000Z'));
    });

    it('lockDecision uses the earliest of startsAtUtc, the order-of-play slot, and day start', async () => {
        const cookie = await member();
        await seed(env, [fixture({
            startsAtUtc: '2026-11-16T20:00:00.000Z',
            orderOfPlay: '2026-11-16T15:00:00.000Z',
            date: '2026-11-17',
            time: '',
            timeZone: 'Europe/Rome',
        })]);
        now = Date.parse('2026-11-16T14:00:00.000Z');
        const opened = await worker.fetch(call('/api/picks/open', { cookie }), env);
        const card = (await opened.json()).data.matches[0];
        expect(card.lockKind).toBe('slot');
        expect(card.locksAtUtc).toBe('2026-11-16T15:00:00.000Z');
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        now = Date.parse('2026-11-16T15:00:00.000Z');
        const res = await postPick(cookie, { matchKey: 'm1', playerKey: '11' });
        expect(res.status).toBe(409);
        expect(env.DB._tables.picks[0].picked_player_key).toBe('10');
        expect(env.DB._tables.picks[0].lock_at).toBe(Date.parse('2026-11-16T15:00:00.000Z'));
    });

    it('signed-out picks and leaderboard requests are 401', async () => {
        for (const [method, path] of [
            ['GET', '/api/picks/open'],
            ['GET', '/api/picks/mine'],
            ['GET', '/api/leaderboard'],
            ['POST', '/api/picks'],
        ]) {
            const res = await worker.fetch(call(path, { method, body: { matchKey: 'm1', playerKey: '10' } }), env);
            expect(res.status, path).toBe(401);
            expect(await res.json()).toEqual({ ok: false, error: 'Sign in to see this.' });
            expect(res.headers.get('Cache-Control')).toBe('private, no-store');
        }
    });

    it('non-member picks and leaderboard requests are 403', async () => {
        const cookie = await member('secret-grace@example.test', 'Grace P', '203.0.113.40');
        const revoked = await worker.fetch(call('/api/admin/members/revoke', {
            method: 'POST', secret: true, body: { email: 'secret-grace@example.test' },
        }), env);
        expect(revoked.status).toBe(200);
        const outsider = cookiePair(await worker.fetch(call('/api/auth/login', {
            method: 'POST',
            ip: '203.0.113.41',
            body: { email: 'secret-grace@example.test', password: 'secret1' },
        }), env));
        for (const [method, path] of [
            ['GET', '/api/picks/open'],
            ['GET', '/api/picks/mine'],
            ['GET', '/api/leaderboard'],
            ['POST', '/api/picks'],
        ]) {
            const res = await worker.fetch(call(path, {
                method, cookie: outsider, body: { matchKey: 'm1', playerKey: '10' },
            }), env);
            expect(res.status, path).toBe(403);
            expect(await res.json()).toEqual({ ok: false, error: 'This part of TennisWorld is invite-only.' });
            expect(res.headers.get('Cache-Control')).toBe('private, no-store');
        }
        expect(cookie).toContain('__Host-tw_session=');
    });

    it('pick writes require same-origin JSON', async () => {
        const cookie = await member();
        const cross = await worker.fetch(call('/api/picks', {
            method: 'POST', cookie, origin: 'https://evil.test', body: { matchKey: 'm1', playerKey: '10' },
        }), env);
        expect(cross.status).toBe(403);
        const text = await worker.fetch(call('/api/picks', {
            method: 'POST', cookie, contentType: 'text/plain', body: { matchKey: 'm1', playerKey: '10' },
        }), env);
        expect(text.status).toBe(415);
    });

    it('keeps one D1 row per member and match and sets timestamps on the server', async () => {
        const cookie = await member();
        await seed(env, [fixture()]);
        const created = now;
        const first = await postPick(cookie, { matchKey: 'm1', playerKey: '10', created_at: 1, updated_at: 1 });
        expect(first.status).toBe(200);
        now += 5000;
        const second = await postPick(cookie, { matchKey: 'm1', playerKey: '11', created_at: 1, rank_gap: 4 });
        expect(second.status).toBe(200);
        expect(env.DB._tables.picks).toHaveLength(1);
        const row = env.DB._tables.picks[0];
        expect(row.picked_player_key).toBe('11');
        expect(row.created_at).toBe(created);
        expect(row.updated_at).toBe(created + 5000);
        expect(row.rank_gap).toBeNull();
        expect(row.result).toBe('pending');
        const mine = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        const body = await mine.json();
        expect(body.data.picks[0].pickedPlayerKey).toBe('11');
        expect(body.data.picks.map(pick => pick.matchKey)).toEqual(['m1']);
    });

    it('the 61st pick change in a minute is 429 with Retry-After', async () => {
        const cookie = await member();
        const other = await member('secret-bea@example.test', 'Bea P', '203.0.113.77');
        await seed(env, [fixture()]);
        for (let i = 1; i <= 60; i++) {
            const res = await postPick(cookie, { matchKey: 'm1', playerKey: i % 2 ? '10' : '11' });
            expect(res.status, String(i)).toBe(200);
        }
        const limited = await postPick(cookie, { matchKey: 'm1', playerKey: '10' });
        expect(limited.status).toBe(429);
        const retry = Number(limited.headers.get('Retry-After'));
        expect(retry).toBeGreaterThan(0);
        expect(await limited.json()).toEqual({ ok: false, error: `Too many changes. Try again in ${retry}s.` });
        expect(limited.headers.get('Cache-Control')).toBe('private, no-store');
        const still = await postPick(other, { matchKey: 'm1', playerKey: '10' }, '203.0.113.77');
        expect(still.status).toBe(200);
    });

    it('returns 400 for a player who is not in the match and for a challenger', async () => {
        const cookie = await member();
        await seed(env, [
            fixture(),
            fixture({ matchKey: 'c1', tier: 'challenger', tournamentName: 'Lyon Challenger', player1Key: '30', player2Key: '31' }),
            fixture({ matchKey: 'd1', eventType: 'ATP Doubles', player1Name: 'A / B', player2Name: 'C / D', player1Key: '40', player2Key: '41' }),
        ]);
        const wrong = await postPick(cookie, { matchKey: 'm1', playerKey: '99' });
        expect(wrong.status).toBe(400);
        const challenger = await postPick(cookie, { matchKey: 'c1', playerKey: '30' });
        expect(challenger.status).toBe(400);
        expect(await challenger.json()).toEqual({ ok: false, error: "That match isn't open for picks." });
        const doubles = await postPick(cookie, { matchKey: 'd1', playerKey: '40' });
        expect(doubles.status).toBe(400);
        const open = await worker.fetch(call('/api/picks/open', { cookie }), env);
        const body = await open.json();
        expect(body.data.matches.map(match => match.matchKey)).toEqual(['m1']);
        expect(open.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('two reads of the same scoreless snapshot stay pending', async () => {
        const cookie = await member();
        await seed(env, [fixture()]);
        await rememberStandings(env, 'ATP', [
            { playerKey: '10', rank: 4, name: 'Alcaraz' },
            { playerKey: '11', rank: 21, name: 'Sinner' },
        ]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        const asOf = new Date(now).toISOString();
        const scoreless = [live({ setScores: [], winner: '10', status: 'Finished', statusText: 'Finished' })];
        putLivescore(env, scoreless, asOf);
        const first = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect((await first.json()).data.picks[0]).toMatchObject({ result: 'pending', voidReason: null });
        expect(env.DB._tables.picks[0].scoreless_first_seen_at).toBe(now);
        expect(env.DB._tables.picks[0].scoreless_status_as_of).toBe(asOf);
        expect(env.DB._tables.picks[0].rank_gap).toBe(17);
        now += 15 * 60 * 1000;
        const second = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect((await second.json()).data.picks[0]).toMatchObject({ result: 'pending', voidReason: null });
        expect(env.DB._tables.picks[0].scoreless_first_seen_at).toBe(now - 15 * 60 * 1000);
    });

    it('a newer scoreless snapshot 15 minutes later voids as walkover', async () => {
        const cookie = await member();
        await seed(env, [fixture()]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        const scoreless = [live({ setScores: [], winner: '10', status: 'Finished', statusText: 'Finished' })];
        putLivescore(env, scoreless, new Date(now).toISOString());
        await worker.fetch(call('/api/picks/mine', { cookie }), env);
        now += 15 * 60 * 1000;
        putLivescore(env, scoreless, new Date(now).toISOString());
        const voided = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        const body = (await voided.json()).data.picks[0];
        expect(body).toMatchObject({ result: 'void', voidReason: 'walkover' });
        expect(JSON.stringify(body)).not.toContain('rank_gap');
        const frozen = JSON.stringify(env.DB._tables.picks[0]);
        await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect(JSON.stringify(env.DB._tables.picks[0])).toBe(frozen);
    });

    it('an inferred walkover that later gains set scores is graded from the winner', async () => {
        const cookie = await member();
        await seed(env, [fixture(), fixture({ matchKey: 'm2', player1Key: '12', player2Key: '13' })]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        expect((await postPick(cookie, { matchKey: 'm2', playerKey: '13' })).status).toBe(200);
        const scoreless = [
            live({ setScores: [], winner: '10' }),
            live({ matchKey: 'm2', player1Key: '12', player2Key: '13', setScores: [], winner: '12' }),
        ];
        putLivescore(env, scoreless, new Date(now).toISOString());
        await worker.fetch(call('/api/picks/mine', { cookie }), env);
        await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect(env.DB._tables.picks.every(row => row.result === 'pending')).toBe(true);
        now += 60_000;
        putLivescore(env, [
            live({ setScores: ['6-4', '6-3'], winner: '10', status: 'Finished', statusText: 'Finished' }),
            live({ matchKey: 'm2', player1Key: '12', player2Key: '13', setScores: ['7-5'], winner: '12', status: 'Finished', statusText: 'Finished' }),
        ], new Date(now).toISOString());
        const res = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        const picks = (await res.json()).data.picks;
        expect(picks.find(pick => pick.matchKey === 'm1')).toMatchObject({ result: 'correct', voidReason: null });
        expect(picks.find(pick => pick.matchKey === 'm2')).toMatchObject({ result: 'wrong', voidReason: null });
    });

    it('voidReason is cancelled for a cancelled match', async () => {
        const cookie = await member();
        await seed(env, [fixture()]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        putLivescore(env, [live({ status: 'Cancelled', statusText: 'Cancelled', winner: '10', setScores: ['6-0'] })]);
        const res = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect((await res.json()).data.picks[0]).toMatchObject({ result: 'void', voidReason: 'cancelled' });
        const again = JSON.stringify(env.DB._tables.picks[0]);
        await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect(JSON.stringify(env.DB._tables.picks[0])).toBe(again);
    });

    it('voidReason is player_changed when the pairing at lock did not play', async () => {
        const cookie = await member();
        await seed(env, [fixture()]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        now = Date.parse('2026-11-18T18:00:00.000Z');
        const locked = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect((await locked.json()).data.picks[0]).toMatchObject({ result: 'pending', voidReason: null });
        expect(env.DB._tables.picks[0].player1_key).toBe('10');
        expect(env.DB._tables.picks[0].player2_key).toBe('11');
        putLivescore(env, [live({
            player1Key: '12',
            player2Key: '11',
            winner: '12',
            setScores: ['6-3', '6-2'],
            status: 'Finished',
            statusText: 'Finished',
        })]);
        const res = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect((await res.json()).data.picks[0]).toMatchObject({ result: 'void', voidReason: 'player_changed' });
        expect(env.DB._tables.picks[0].player1_key).toBe('10');
        expect(env.DB._tables.picks[0].player2_key).toBe('11');
    });

    it('grades a retirement before the first game from the recorded winner', async () => {
        const cookie = await member();
        await seed(env, [fixture()]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '10' })).status).toBe(200);
        for (const text of ['Ret.', 'Retired', 'Finished (retired)']) {
            putLivescore(env, [live({ status: text, statusText: text, winner: '10', setScores: [] })]);
            const res = await worker.fetch(call('/api/picks/mine', { cookie }), env);
            const pick = (await res.json()).data.picks[0];
            expect(pick, text).toMatchObject({ result: 'correct', voidReason: null });
            expect(pick.result).not.toBe('void');
        }
        putLivescore(env, [live({ status: 'Finished', statusText: 'Finished', winner: '10', setScores: [] })]);
        const later = await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect((await later.json()).data.picks[0]).toMatchObject({ result: 'correct', voidReason: null });
        expect(env.DB._tables.picks[0].void_reason).toBe('');
    });

    it('regrading the same result does not change the row', async () => {
        const cookie = await member();
        await seed(env, [fixture()]);
        expect((await postPick(cookie, { matchKey: 'm1', playerKey: '11' })).status).toBe(200);
        putLivescore(env, [live({ setScores: ['6-4', '3-2'], winner: '10', status: 'Finished', statusText: 'Finished' })]);
        await worker.fetch(call('/api/picks/mine', { cookie }), env);
        expect(env.DB._tables.picks[0].result).toBe('wrong');
        const frozen = JSON.stringify(env.DB._tables.picks[0]);
        await worker.fetch(call('/api/picks/mine', { cookie }), env);
        await worker.fetch(call('/api/leaderboard', { cookie }), env);
        expect(JSON.stringify(env.DB._tables.picks[0])).toBe(frozen);
    });

    it('leaderboard and picks responses contain no emails, member ids, or rank_gap', async () => {
        const ada = await member('secret-ada@example.test', 'Ada P', '203.0.113.10');
        const bea = await member('secret-bea@example.test', 'Bea P', '203.0.113.11');
        const cam = await member('secret-cam@example.test', 'Cam P', '203.0.113.12');
        const grace = await member('secret-grace@example.test', 'Grace P', '203.0.113.13');
        await seed(env, [
            fixture({ matchKey: 'a' }),
            fixture({ matchKey: 'b', player1Key: '20', player2Key: '21', player1Name: 'Zverev', player2Name: 'Medvedev' }),
            fixture({ matchKey: 'c', player1Key: '30', player2Key: '31' }),
            fixture({ matchKey: 'w', player1Key: '40', player2Key: '41' }),
        ]);
        await rememberStandings(env, 'ATP', [
            { playerKey: '10', rank: 4, name: 'Alcaraz' },
            { playerKey: '11', rank: 21, name: 'Sinner' },
        ]);
        now = 1_700_000_000_000;
        expect((await postPick(ada, { matchKey: 'a', playerKey: '10' }, '203.0.113.10')).status).toBe(200);
        expect((await postPick(cam, { matchKey: 'a', playerKey: '10' }, '203.0.113.12')).status).toBe(200);
        expect((await postPick(bea, { matchKey: 'b', playerKey: '21' }, '203.0.113.11')).status).toBe(200);
        expect((await postPick(grace, { matchKey: 'c', playerKey: '30' }, '203.0.113.13')).status).toBe(200);
        expect((await postPick(ada, { matchKey: 'w', playerKey: '40' }, '203.0.113.10')).status).toBe(200);
        now += 1000;
        expect((await postPick(grace, { matchKey: 'b', playerKey: '21' }, '203.0.113.13')).status).toBe(200);

        const boardRows = [
            live({ matchKey: 'a', winner: '10', setScores: ['6-4', '6-4'] }),
            live({ matchKey: 'b', player1Key: '20', player2Key: '21', winner: '20', setScores: ['6-3', '6-2'] }),
            live({ matchKey: 'c', player1Key: '30', player2Key: '31', winner: '30', setScores: ['7-6', '6-4'] }),
            live({ matchKey: 'w', player1Key: '40', player2Key: '41', winner: '40', setScores: [], status: 'Finished', statusText: 'Finished' }),
        ];
        putLivescore(env, boardRows, new Date(now).toISOString());
        await worker.fetch(call('/api/picks/mine', { cookie: ada }), env);
        now += 15 * 60 * 1000;
        putLivescore(env, boardRows, new Date(now).toISOString());
        await worker.fetch(call('/api/picks/mine', { cookie: ada }), env);

        const mine = await worker.fetch(call('/api/picks/mine', { cookie: ada }), env);
        const open = await worker.fetch(call('/api/picks/open', { cookie: ada }), env);
        const board = await worker.fetch(call('/api/leaderboard', { cookie: ada }), env);
        expect(mine.headers.get('Cache-Control')).toBe('private, no-store');
        expect(board.headers.get('Cache-Control')).toBe('private, no-store');
        const mineBody = await mine.json();
        const openBody = await open.json();
        const boardBody = await board.json();
        const packed = JSON.stringify([mineBody, openBody, boardBody]);
        for (const secret of ['secret-ada@example.test', 'secret-bea@example.test', 'secret-cam@example.test', 'secret-grace@example.test', 'rank_gap', 'rankGap', 'member_id', 'memberId']) {
            expect(packed.includes(secret), secret).toBe(false);
        }
        const keys = keysDeep([mineBody, openBody, boardBody]);
        expect(keys).not.toContain('rank_gap');
        expect(keys).not.toContain('email');
        expect(keys).not.toContain('member_id');
        expect(mineBody.data.picks.find(pick => pick.matchKey === 'w').voidReason).toBe('walkover');
        expect(env.DB._tables.picks.find(row => row.match_key === 'a' && row.member_id.includes('ada')).rank_gap).toBe(17);

        expect(boardBody.data).toEqual([
            { rank: 1, displayName: 'Ada P', points: 1, graded: 1 },
            { rank: 1, displayName: 'Cam P', points: 1, graded: 1 },
            { rank: 3, displayName: 'Grace P', points: 1, graded: 2 },
            { rank: 4, displayName: 'Bea P', points: 0, graded: 1 },
        ]);
    });

    it('persisted lock and grade do not depend on statusMemory', async () => {
        const cookie = await member();
        const row = fixture({ startsAtUtc: '2026-11-16T18:00:00.000Z' });
        await seed(env, [row]);
        env.TENNIS_CACHE._store.set('tw:fixtures5:ATP:all::', JSON.stringify({
            data: [row],
            cachedAt: '2026-11-16T12:00:00.000Z',
        }));
        const calls = [];
        const original = globalThis.fetch;
        globalThis.fetch = (...args) => {
            calls.push(args[0]);
            throw new Error('upstream');
        };
        try {
            putLivescore(env, [live()]);
            const warmed = await worker.fetch(call('/api/fixtures?tour=ATP'), env);
            expect(warmed.status).toBe(200);
            const warmedBody = await warmed.json();
            expect(warmedBody.data[0].status).toBe('Finished');
            putLivescore(env, [live({ status: 'Not Started', statusText: 'Not Started', winner: '', setScores: [] })]);
            const stuck = await worker.fetch(call('/api/fixtures?tour=ATP'), env);
            expect((await stuck.json()).data[0].status).toBe('Finished');
            const picked = await postPick(cookie, { matchKey: 'm1', playerKey: '10' });
            expect(picked.status).toBe(200);
            expect(env.DB._tables.picks[0].locked_at).toBeNull();
            expect(env.DB._tables.picks[0].result).toBe('pending');

            putLivescore(env, [live()]);
            const graded = await worker.fetch(call('/api/picks/mine', { cookie }), env);
            expect((await graded.json()).data.picks[0].result).toBe('correct');
            const lockedAt = env.DB._tables.picks[0].locked_at;
            resetFixtureStatusMemoryForTests();
            putLivescore(env, [live({ status: 'Not Started', statusText: 'Not Started', winner: '', setScores: [] })]);
            const again = await worker.fetch(call('/api/picks/mine', { cookie }), env);
            expect((await again.json()).data.picks[0]).toMatchObject({ result: 'correct', voidReason: null });
            expect(env.DB._tables.picks[0].locked_at).toBe(lockedAt);
            const changed = await postPick(cookie, { matchKey: 'm1', playerKey: '11' });
            expect(changed.status).toBe(409);
            expect(env.DB._tables.picks[0].picked_player_key).toBe('10');
            expect(env.DB._tables.picks[0].result).toBe('correct');
            expect(calls).toEqual([]);
        } finally {
            globalThis.fetch = original;
        }
    });
});
