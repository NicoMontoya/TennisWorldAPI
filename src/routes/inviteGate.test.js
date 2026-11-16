import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../index.js';
import { createMemoryD1 } from '../d1Memory.js';
import { publicUser, DISPLAY_NAME_ERROR, RATE_LIMIT_ERROR } from './auth.js';
import { INVITE_BYTES, INVITE_ERROR, canonicalInviteCode, inviteKeyHash } from './invites.js';

const ORIGIN = 'https://example.test';
const SECRET = 'test-admin-secret';
const GENERIC = { ok: false, error: INVITE_ERROR };

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
            async list({ prefix = '', cursor, limit = 1000 } = {}) {
                const keys = [...store.keys()].filter(k => String(k).startsWith(prefix)).sort();
                let start = 0;
                if (cursor) {
                    const idx = keys.indexOf(cursor);
                    start = idx === -1 ? keys.length : idx + 1;
                }
                const slice = keys.slice(start, start + limit);
                const next = start + slice.length;
                return {
                    keys: slice.map(name => ({ name })),
                    list_complete: next >= keys.length,
                    cursor: next < keys.length ? slice[slice.length - 1] : undefined,
                };
            },
            _store: store,
        },
    };
}

function call(path, { method = 'GET', body, cookie, ip, secret, origin, authorization, contentType } = {}) {
    const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
    const headers = {};
    if (method === 'POST') {
        if (origin !== null) headers.Origin = origin || new URL(url).origin;
        if (contentType !== null) headers['Content-Type'] = contentType || 'application/json';
    }
    if (cookie) headers.Cookie = cookie;
    if (ip) headers['CF-Connecting-IP'] = ip;
    if (secret) headers['x-admin-secret'] = secret === true ? SECRET : secret;
    if (authorization) headers.Authorization = authorization;
    return new Request(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body === undefined ? {} : body) : undefined,
    });
}

function setCookieLines(response) {
    return typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
}

function cookiePair(response) {
    const line = setCookieLines(response).find(value => value && value.startsWith('__Host-tw_session=')) || '';
    return line.split(';')[0];
}

function sessionIdFrom(pair) {
    return pair.split('=')[1] || '';
}

async function issue(env, fields = {}) {
    const res = await worker.fetch(call('/api/admin/invites', {
        method: 'POST',
        body: fields,
        secret: true,
    }), env);
    expect(res.status, 'issue invite').toBe(200);
    const json = await res.json();
    return json.data;
}

const PERSON = { firstName: 'Ada', lastName: 'Lovelace', password: 'secret1', displayName: 'Ada L' };

async function register(env, { email = 'ada@example.com', inviteCode, ip = '203.0.113.10', ...rest } = {}) {
    const code = inviteCode || (await issue(env)).code;
    const res = await worker.fetch(call('/api/auth/register', {
        method: 'POST',
        ip,
        body: { ...PERSON, email, inviteCode: code, ...rest },
    }), env);
    return { res, code };
}

function seedDraw(env) {
    env.TENNIS_CACHE._store.set('tw:draws14:123:ATP', JSON.stringify({
        data: {
            tournamentKey: '123',
            rounds: [{
                round: 'Final',
                order: 1,
                matches: [{
                    matchKey: '1',
                    roundId: 12,
                    player1Key: '10',
                    player2Key: '11',
                    winner: null,
                }],
            }],
        },
        cachedAt: new Date().toISOString(),
        stale: false,
    }));
}

describe('invite codes', () => {
    let env;
    beforeEach(() => { env = mockEnv(); });

    it('draws 128+ bits and returns a grouped code once', async () => {
        const spy = vi.spyOn(crypto, 'getRandomValues');
        const codes = new Set();
        for (let i = 0; i < 8; i++) {
            const issued = await issue(env, { note: 'friends' });
            const compact = issued.code.replace(/-/g, '');
            expect(issued.code).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){7}$/);
            expect(compact).toHaveLength(32);
            codes.add(issued.code);
        }
        expect(codes.size).toBe(8);
        expect(INVITE_BYTES).toBeGreaterThanOrEqual(16);
        expect(spy.mock.calls.some(callArgs => callArgs[0]?.byteLength >= 16)).toBe(true);
        spy.mockRestore();
    });

    it('stores only the hash in D1, never the code and never KV', async () => {
        const issued = await issue(env, { note: 'sunday' });
        const compact = canonicalInviteCode(issued.code);
        const hash = await inviteKeyHash(compact);
        expect(issued.hash).toBe(hash);
        const row = env.DB._tables.invites.find(item => item.hash === hash);
        expect(row).toMatchObject({ hash, max_uses: 1, uses: 0, revoked: 0, note: 'sunday' });
        const dumped = JSON.stringify(env.DB._tables.invites);
        expect(dumped.includes(compact)).toBe(false);
        expect(dumped.includes(issued.code)).toBe(false);
        expect([...env.TENNIS_CACHE._store.keys()].some(k => String(k).startsWith('_invite:'))).toBe(false);

        const listed = await worker.fetch(call('/api/admin/invites/list', {
            method: 'POST',
            secret: true,
        }), env);
        const body = await listed.json();
        expect(listed.status).toBe(200);
        expect(body.data.invites).toEqual([expect.objectContaining({
            hash, uses: 0, revoked: false, note: 'sunday',
        })]);
        expect(JSON.stringify(body).includes(compact)).toBe(false);
        expect(Object.keys(body.data.invites[0]).sort()).toEqual(
            ['createdAt', 'hash', 'maxUses', 'note', 'revoked', 'uses'],
        );
    });

    it('fails closed when ADMIN_SECRET is unset and rejects a note that is an email', async () => {
        const closed = mockEnv();
        delete closed.ADMIN_SECRET;
        const missing = await worker.fetch(call('/api/admin/invites', { method: 'POST', secret: true }), closed);
        expect(missing.status).toBe(401);

        const wrong = await worker.fetch(call('/api/admin/invites', {
            method: 'POST',
            secret: 'test',
        }), env);
        expect(wrong.status).toBe(401);

        const emailed = await worker.fetch(call('/api/admin/invites', {
            method: 'POST',
            secret: true,
            body: { note: 'nico@example.com' },
        }), env);
        expect(emailed.status).toBe(400);
        expect(env.DB._tables.invites).toHaveLength(0);
    });

    it('uses a code once, and a revoked code fails with the generic error', async () => {
        const issued = await issue(env);
        const first = await register(env, { email: 'ada@example.com', inviteCode: issued.code, ip: '203.0.113.20' });
        expect(first.res.status).toBe(200);
        const second = await register(env, { email: 'grace@example.com', inviteCode: issued.code, ip: '203.0.113.21' });
        expect(second.res.status).toBe(400);
        expect(await second.res.json()).toEqual(GENERIC);
        expect(env.DB._tables.invites.find(row => row.hash === issued.hash).uses).toBe(1);

        const revoked = await issue(env);
        const kill = await worker.fetch(call('/api/admin/invites/revoke', {
            method: 'POST',
            secret: true,
            body: { hash: revoked.hash },
        }), env);
        expect(kill.status).toBe(200);
        const attempt = await register(env, { email: 'linus@example.com', inviteCode: revoked.code, ip: '203.0.113.22' });
        expect(attempt.res.status).toBe(400);
        expect(await attempt.res.json()).toEqual(GENERIC);
        expect(env.DB._tables.invites.find(row => row.hash === revoked.hash)).toMatchObject({ uses: 0, revoked: 1 });
    });

    it('returns the same body for a wrong code and a duplicate email', async () => {
        const first = await issue(env);
        const created = await register(env, { email: 'ada@example.com', inviteCode: first.code, ip: '203.0.113.30' });
        expect(created.res.status).toBe(200);

        const second = await issue(env);
        const duplicate = await worker.fetch(call('/api/auth/register', {
            method: 'POST',
            ip: '203.0.113.31',
            body: { ...PERSON, email: 'ada@example.com', inviteCode: second.code },
        }), env);
        const wrong = await worker.fetch(call('/api/auth/register', {
            method: 'POST',
            ip: '203.0.113.32',
            body: { ...PERSON, email: 'fresh@example.com', inviteCode: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        }), env);
        expect(duplicate.status).toBe(wrong.status);
        expect(duplicate.status).toBe(400);
        expect(await duplicate.text()).toBe(await wrong.text());
        expect(env.DB._tables.invites.find(row => row.hash === second.hash).uses).toBe(0);
    });

    it('claims one use when two redeems of the same code run together', async () => {
        const ada = await register(env, { email: 'ada@example.com', ip: '203.0.113.40' });
        const grace = await register(env, { email: 'grace@example.com', ip: '203.0.113.41' });
        expect(ada.res.status).toBe(200);
        expect(grace.res.status).toBe(200);
        const adaCookie = cookiePair(ada.res);
        const graceCookie = cookiePair(grace.res);
        const shared = await issue(env, { maxUses: 1 });

        const [left, right] = await Promise.all([
            worker.fetch(call('/api/auth/redeem', {
                method: 'POST',
                cookie: adaCookie,
                ip: '203.0.113.42',
                body: { inviteCode: shared.code },
            }), env),
            worker.fetch(call('/api/auth/redeem', {
                method: 'POST',
                cookie: graceCookie,
                ip: '203.0.113.43',
                body: { inviteCode: shared.code },
            }), env),
        ]);
        const statuses = [left.status, right.status].sort();
        expect(statuses).toEqual([200, 400]);
        const bodies = await Promise.all([left.json(), right.json()]);
        const failed = bodies.find(body => body.ok === false);
        const succeeded = bodies.find(body => body.ok === true);
        expect(failed).toEqual(GENERIC);
        expect(succeeded.data.user.member).toBe(true);
        expect(env.DB._tables.invites.find(row => row.hash === shared.hash).uses).toBe(1);
        expect([...env.TENNIS_CACHE._store.keys()].filter(k => String(k).startsWith('_user:'))).toHaveLength(2);
    });

    it('returns 429 on the 11th attempt across login, register, and redeem', async () => {
        const ip = '203.0.113.50';
        for (let i = 0; i < 5; i++) {
            const res = await worker.fetch(call('/api/auth/login', {
                method: 'POST',
                ip,
                body: { email: 'ada@example.com', password: 'nope' },
            }), env);
            expect(res.status).not.toBe(429);
        }
        for (let i = 0; i < 5; i++) {
            const res = await worker.fetch(call('/api/auth/register', {
                method: 'POST',
                ip,
                body: { ...PERSON, email: `u${i}@example.com`, inviteCode: 'nope' },
            }), env);
            expect(res.status).not.toBe(429);
        }
        const limited = await worker.fetch(call('/api/auth/redeem', {
            method: 'POST',
            ip,
            body: { inviteCode: 'nope' },
        }), env);
        expect(limited.status).toBe(429);
        expect(await limited.json()).toEqual({ ok: false, error: RATE_LIMIT_ERROR });
        expect(limited.headers.get('cache-control')).toBe('private, no-store');
    });
});

describe('member gate, sessions, and privacy', () => {
    let env;
    beforeEach(() => { env = mockEnv(); seedDraw(env); });

    async function signedIn(email, ip) {
        const { res } = await register(env, { email, ip });
        expect(res.status).toBe(200);
        return cookiePair(res);
    }

    it('gates each member route: 401, 403, then 200, all no-store', async () => {
        const member = await signedIn('ada@example.com', '203.0.113.60');
        const grace = await signedIn('grace@example.com', '203.0.113.61');
        const revoked = await worker.fetch(call('/api/admin/members/revoke', {
            method: 'POST',
            secret: true,
            body: { email: 'grace@example.com' },
        }), env);
        expect(revoked.status).toBe(200);
        const outsider = cookiePair(await worker.fetch(call('/api/auth/login', {
            method: 'POST',
            ip: '203.0.113.62',
            body: { email: 'grace@example.com', password: 'secret1' },
        }), env));

        const routes = [
            { method: 'GET', path: '/api/favorites' },
            { method: 'POST', path: '/api/favorites/toggle', body: { playerKey: '10', name: 'Ada' } },
            { method: 'GET', path: '/api/bracket/mine' },
            { method: 'GET', path: '/api/bracket/leaders?tournamentKey=123&tour=ATP' },
            { method: 'POST', path: '/api/bracket/save', body: { tour: 'ATP', tournamentKey: '123', picks: { '1': '10' } } },
        ];
        let publicId = '';
        for (const route of routes) {
            const signedOut = await worker.fetch(call(route.path, { method: route.method, body: route.body }), env);
            expect(signedOut.status, route.path).toBe(401);
            expect(await signedOut.json(), route.path).toEqual({ ok: false, error: 'Sign in to see this.' });
            expect(signedOut.headers.get('cache-control'), route.path).toBe('private, no-store');

            const nonMember = await worker.fetch(call(route.path, {
                method: route.method,
                body: route.body,
                cookie: outsider,
            }), env);
            expect(nonMember.status, route.path).toBe(403);
            expect(await nonMember.json(), route.path).toEqual({
                ok: false,
                error: 'This part of TennisWorld is invite-only.',
            });
            expect(nonMember.headers.get('cache-control'), route.path).toBe('private, no-store');

            const allowed = await worker.fetch(call(route.path, {
                method: route.method,
                body: route.body,
                cookie: member,
            }), env);
            expect(allowed.status, route.path).toBe(200);
            expect(allowed.headers.get('cache-control'), route.path).toBe('private, no-store');
            const payload = await allowed.json();
            expect(JSON.stringify(payload)).not.toContain('ada@example.com');
            expect(JSON.stringify(payload)).not.toContain('passwordHash');
            if (route.path === '/api/bracket/save') {
                const user = JSON.parse(env.TENNIS_CACHE._store.get('_user:ada@example.com'));
                publicId = user.publicId;
            }
        }

        const pubPath = `/api/bracket/public?id=${publicId}&tournamentKey=123&tour=ATP`;
        const hidden = await worker.fetch(call(pubPath), env);
        expect(hidden.status).toBe(401);
        expect(hidden.headers.get('cache-control')).toBe('private, no-store');
        const blocked = await worker.fetch(call(pubPath, { cookie: outsider }), env);
        expect(blocked.status).toBe(403);
        const shown = await worker.fetch(call(pubPath, { cookie: member }), env);
        expect(shown.status).toBe(200);
        expect(shown.headers.get('cache-control')).toBe('private, no-store');
        const shownBody = await shown.json();
        expect(shownBody.data.publicId).toBe(publicId);
        expect(shownBody.data.displayName).toBe('Ada L');
        expect(shownBody.data.email).toBeUndefined();
        expect(shownBody.data.userId).toBeUndefined();

        for (const path of ['/api/picks', '/api/picks/today', '/api/leaderboard', '/api/leaderboard/week', '/api/me/record']) {
            const out = await worker.fetch(call(path), env);
            expect(out.status, path).toBe(401);
            expect(out.headers.get('cache-control'), path).toBe('private, no-store');
            const denied = await worker.fetch(call(path, { cookie: outsider }), env);
            expect(denied.status, path).toBe(403);
            const passed = await worker.fetch(call(path, { cookie: member }), env);
            expect(passed.status, path).toBe(404);
        }
    });

    it('sets the host cookie and rejects a cross-origin or Bearer-only request', async () => {
        const { res } = await register(env, { email: 'ada@example.com', ip: '203.0.113.70' });
        const lines = res.headers.getSetCookie();
        expect(lines).toHaveLength(1);
        const setCookie = lines[0];
        expect(setCookie).toContain('__Host-tw_session=');
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('Secure');
        expect(setCookie).toContain('SameSite=Lax');
        expect(setCookie).toContain('Path=/');
        expect(setCookie).toContain('Max-Age=2592000');
        expect(setCookie).not.toMatch(/Domain=/i);
        const cookie = cookiePair(res);
        const id = sessionIdFrom(cookie);

        const again = await worker.fetch(call('/api/auth/login', {
            method: 'POST',
            ip: '203.0.113.71',
            body: { email: 'ada@example.com', password: 'secret1' },
        }), env);
        const second = sessionIdFrom(cookiePair(again));
        expect(second).not.toBe(id);
        expect(await env.TENNIS_CACHE.get(`_sess2:${id}`, 'json')).toBeTruthy();
        expect(await env.TENNIS_CACHE.get(`_sess2:${second}`, 'json')).toBeTruthy();

        const bearer = await worker.fetch(call('/api/auth/me', { authorization: `Bearer ${id}` }), env);
        expect(bearer.status).toBe(401);
        const legacyId = 'legacy-session-token';
        await env.TENNIS_CACHE.put(`_session:${legacyId}`, JSON.stringify({
            email: 'ada@example.com',
            expiresAt: Date.now() + 60_000,
        }));
        const legacy = await worker.fetch(call('/api/auth/me', {
            cookie: `__Host-tw_session=${legacyId}`,
        }), env);
        expect(legacy.status).toBe(401);

        const cross = await worker.fetch(call('/api/auth/login', {
            method: 'POST',
            origin: 'https://evil.example',
            body: { email: 'ada@example.com', password: 'secret1' },
        }), env);
        expect(cross.status).toBe(403);
        const missing = await worker.fetch(call('/api/favorites/toggle', {
            method: 'POST',
            origin: null,
            cookie,
            body: { playerKey: '10' },
        }), env);
        expect(missing.status).toBe(403);

        const out = await worker.fetch(call('/api/auth/logout', { method: 'POST', cookie }), env);
        expect(out.status).toBe(200);
        expect(setCookieLines(out).join(';')).toContain('Max-Age=0');
        expect(await env.TENNIS_CACHE.get(`_sess2:${id}`, 'json')).toBeNull();
        const after = await worker.fetch(call('/api/auth/me', { cookie }), env);
        expect(after.status).toBe(401);
        expect(await env.TENNIS_CACHE.get(`_sess2:${second}`, 'json')).toBeTruthy();
    });

    it('after member-revoke, the cookie and gated routes fail on the next request', async () => {
        const { res } = await register(env, { email: 'ada@example.com', ip: '203.0.113.80' });
        const cookie = cookiePair(res);
        const id = sessionIdFrom(cookie);
        const other = cookiePair(await worker.fetch(call('/api/auth/login', {
            method: 'POST',
            ip: '203.0.113.81',
            body: { email: 'ada@example.com', password: 'secret1' },
        }), env));
        const otherId = sessionIdFrom(other);

        const revoked = await worker.fetch(call('/api/admin/members/revoke', {
            method: 'POST',
            secret: true,
            body: { email: 'ada@example.com' },
        }), env);
        expect(revoked.status).toBe(200);
        expect(await env.TENNIS_CACHE.get(`_sess2:${id}`, 'json')).toBeNull();
        expect(await env.TENNIS_CACHE.get(`_sess2:${otherId}`, 'json')).toBeNull();

        const gated = await worker.fetch(call('/api/favorites', { cookie }), env);
        expect(gated.status).toBe(401);
        expect(await gated.json()).toEqual({ ok: false, error: 'Sign in to see this.' });
        const me = await worker.fetch(call('/api/auth/me', { cookie: other }), env);
        expect(me.status).toBe(401);
        const mine = await worker.fetch(call('/api/bracket/mine', { cookie }), env);
        expect(mine.status).toBe(401);

        const relog = await worker.fetch(call('/api/auth/login', {
            method: 'POST',
            ip: '203.0.113.82',
            body: { email: 'ada@example.com', password: 'secret1' },
        }), env);
        expect(relog.status).toBe(200);
        const fresh = cookiePair(relog);
        expect((await relog.json()).data.user.member).toBe(false);
        const still = await worker.fetch(call('/api/favorites', { cookie: fresh }), env);
        expect(still.status).toBe(403);
    });

    it('changing the password kills every session', async () => {
        const { res } = await register(env, { email: 'ada@example.com', ip: '203.0.113.90' });
        const first = cookiePair(res);
        const second = cookiePair(await worker.fetch(call('/api/auth/login', {
            method: 'POST',
            ip: '203.0.113.91',
            body: { email: 'ada@example.com', password: 'secret1' },
        }), env));
        const changed = await worker.fetch(call('/api/auth/change-password', {
            method: 'POST',
            cookie: first,
            body: { currentPassword: 'secret1', newPassword: 'secret2' },
        }), env);
        expect(changed.status).toBe(200);
        expect(setCookieLines(changed).join(';')).toContain('Max-Age=0');
        expect((await worker.fetch(call('/api/auth/me', { cookie: first }), env)).status).toBe(401);
        expect((await worker.fetch(call('/api/bracket/mine', { cookie: second }), env)).status).toBe(401);
        expect(await env.TENNIS_CACHE.get(`_sess2:${sessionIdFrom(first)}`, 'json')).toBeNull();
        expect(await env.TENNIS_CACHE.get(`_sess2:${sessionIdFrom(second)}`, 'json')).toBeNull();
    });

    it('publicUser exposes member and hides secrets, and display names are checked', async () => {
        const pub = publicUser({
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            favorites: [],
            createdAt: 1,
            displayName: 'Ada',
            member: true,
            memberSince: 2,
            sessions: ['secret-session'],
            passwordHash: 'hash',
            salt: 'salt',
        });
        expect(pub.member).toBe(true);
        expect(pub).not.toHaveProperty('sessions');
        expect(pub).not.toHaveProperty('passwordHash');
        expect(pub).not.toHaveProperty('salt');

        const { res, code } = await register(env, { email: 'ada@example.com', ip: '203.0.113.100' });
        const body = await res.json();
        expect(body.data.user.member).toBe(true);
        expect(body.data.user.passwordHash).toBeUndefined();
        expect(body.data.user.salt).toBeUndefined();
        expect(body.data.user.sessions).toBeUndefined();

        const cookie = cookiePair(res);
        const bad = await worker.fetch(call('/api/auth/update-profile', {
            method: 'POST',
            cookie,
            body: { displayName: '<script>alert(1)</script>' },
        }), env);
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({ ok: false, error: DISPLAY_NAME_ERROR });

        const empty = await worker.fetch(call('/api/auth/update-profile', {
            method: 'POST',
            cookie,
            body: { displayName: '   ' },
        }), env);
        expect(empty.status).toBe(400);

        const long = await worker.fetch(call('/api/auth/update-profile', {
            method: 'POST',
            cookie,
            body: { displayName: 'A'.repeat(25) },
        }), env);
        expect(long.status).toBe(400);

        const ok = await worker.fetch(call('/api/auth/update-profile', {
            method: 'POST',
            cookie,
            body: { displayName: "Ann-Marie O'Neil" },
        }), env);
        expect(ok.status).toBe(200);
        expect((await ok.json()).data.displayName).toBe("Ann-Marie O'Neil");

        const row = env.DB._tables.invites.find(item => item.uses === 1);
        expect(row.hash).toBe((await inviteKeyHash(canonicalInviteCode(code))));
    });
});

describe('POST /api/auth/update-profile {displayName}', () => {
    let env;
    let cookie;
    beforeEach(async () => {
        env = mockEnv();
        const { res } = await register(env, { email: 'ada@example.com', ip: '203.0.113.110' });
        expect(res.status).toBe(200);
        cookie = cookiePair(res);
    });

    async function saveName(displayName, extra = {}) {
        return worker.fetch(call('/api/auth/update-profile', {
            method: 'POST',
            cookie,
            body: { displayName },
            ...extra,
        }), env);
    }

    it('registers from the invite form without a last name', async () => {
        const issued = await issue(env);
        const res = await worker.fetch(call('/api/auth/register', {
            method: 'POST',
            ip: '203.0.113.111',
            body: {
                inviteCode: issued.code,
                firstName: 'Grace',
                email: 'grace@example.com',
                password: 'secret1',
            },
        }), env);
        expect(res.status).toBe(200);
        expect((await res.json()).data.user).toMatchObject({
            firstName: 'Grace',
            lastName: '',
            displayName: 'Grace',
            email: 'grace@example.com',
            member: true,
        });
    });

    it('saves a display name from the cookie session and returns publicUser', async () => {
        const res = await saveName('Ada 2');
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        const json = await res.json();
        expect(json.ok).toBe(true);
        expect(json.data).toMatchObject({
            displayName: 'Ada 2',
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            member: true,
        });
        expect(json.data.passwordHash).toBeUndefined();
        expect(json.data.salt).toBeUndefined();
        expect(json.data.sessions).toBeUndefined();
        expect(JSON.parse(env.TENNIS_CACHE._store.get('_user:ada@example.com')).displayName).toBe('Ada 2');

        const me = await worker.fetch(call('/api/auth/me', { cookie }), env);
        expect((await me.json()).data.displayName).toBe('Ada 2');

        const edge = await saveName('A'.repeat(24));
        expect(edge.status).toBe(200);
        expect((await edge.json()).data.displayName).toBe('A'.repeat(24));

        const punctuated = await saveName("Ann-Marie O'Neil.");
        expect(punctuated.status).toBe(200);
        expect((await punctuated.json()).data.displayName).toBe("Ann-Marie O'Neil.");
    });

    it('returns 400 for a name outside the 1-24 character rule', async () => {
        for (const displayName of ['', '   ', 'A'.repeat(25), '<script>', 'Ada!', 'Ada@home']) {
            const res = await saveName(displayName);
            expect(res.status, JSON.stringify(displayName)).toBe(400);
            expect(await res.json(), JSON.stringify(displayName)).toEqual({
                ok: false,
                error: DISPLAY_NAME_ERROR,
            });
        }
        expect(JSON.parse(env.TENNIS_CACHE._store.get('_user:ada@example.com')).displayName).toBe('Ada L');
    });

    it('requires a same-origin Origin and a cookie', async () => {
        const cross = await saveName('Renamed', { origin: 'https://evil.example' });
        expect(cross.status).toBe(403);
        const missing = await saveName('Renamed', { origin: null });
        expect(missing.status).toBe(403);
        const signedOut = await worker.fetch(call('/api/auth/update-profile', {
            method: 'POST',
            body: { displayName: 'Renamed' },
        }), env);
        expect(signedOut.status).toBe(401);
        expect(JSON.parse(env.TENNIS_CACHE._store.get('_user:ada@example.com')).displayName).toBe('Ada L');
    });
});

describe('noindex', () => {
    it('marks HTML, /api/fixtures, and robots.txt', async () => {
        const html = '<!doctype html><html><head><title>TennisWorld</title></head><body></body></html>';
        const env = {
            CORS_ORIGIN: ORIGIN,
            ASSETS: {
                async fetch() {
                    return new Response(html, {
                        status: 200,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    });
                },
            },
        };
        const page = await worker.fetch(new Request(`${ORIGIN}/today`), env);
        expect(page.status).toBe(200);
        expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
        expect(await page.text()).toContain('<meta name="robots" content="noindex,nofollow">');

        const fixtures = await worker.fetch(new Request(`${ORIGIN}/api/fixtures?tour=ITF`), mockEnv());
        expect(fixtures.headers.get('x-robots-tag')).toBe('noindex, nofollow');

        const robots = await worker.fetch(new Request(`${ORIGIN}/robots.txt`), env);
        expect(robots.status).toBe(200);
        expect(await robots.text()).toContain('Disallow: /');
        expect(robots.headers.get('x-robots-tag')).toBe('noindex, nofollow');

        const head = await worker.fetch(new Request(`${ORIGIN}/today`, { method: 'HEAD' }), env);
        const get = await worker.fetch(new Request(`${ORIGIN}/today`), env);
        expect(head.status).toBe(get.status);
    });
});
