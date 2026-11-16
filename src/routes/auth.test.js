import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryD1 } from '../d1Memory.js';
import { issueInvite } from './invites.js';
import {
    isValidEmail,
    handleRegister,
    handleLogin,
    handleLogout,
    handleMe,
    handleChangePassword,
    getAuthUser,
    takeSetCookies,
} from './auth.js';

function mockEnv() {
    const store = new Map();
    return {
        DB: createMemoryD1(),
        TENNIS_CACHE: {
            async get(key, type) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json' || type?.type === 'json') return JSON.parse(raw);
                return raw;
            },
            async put(key, value) {
                store.set(key, value);
            },
            async delete(key) {
                store.delete(key);
            },
            _store: store,
        },
    };
}

function post(body, { cookie } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    return new Request('https://example.test/api/auth', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

function get({ cookie, authorization } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (authorization) headers.Authorization = authorization;
    return new Request('https://example.test/api/auth/me', { headers });
}

function sessionFrom(result) {
    const line = (takeSetCookies(result)[0] || '');
    const pair = line.split(';')[0];
    return { line, pair, id: pair.split('=')[1] || '' };
}

async function expectReject(promise, status, messageRe) {
    await expect(promise).rejects.toMatchObject({
        status,
        message: expect.stringMatching(messageRe),
    });
}

const PERSON = { firstName: 'Ada', lastName: 'Lovelace', password: 'secret1' };

describe('isValidEmail', () => {
    it('accepts ordinary addr@domain.tld addresses', () => {
        expect(isValidEmail('user@example.com')).toBe(true);
        expect(isValidEmail('  User.Name+tag@sub.example.co.uk  ')).toBe(true);
    });

    it('rejects clearly invalid emails', () => {
        expect(isValidEmail('notanemail')).toBe(false);
        expect(isValidEmail('user@')).toBe(false);
        expect(isValidEmail('@example.com')).toBe(false);
        expect(isValidEmail('a@b')).toBe(false);
        expect(isValidEmail('user @example.com')).toBe(false);
        expect(isValidEmail('user@@example.com')).toBe(false);
        expect(isValidEmail('')).toBe(false);
        expect(isValidEmail(null)).toBe(false);
    });
});

describe('auth routes', () => {
    let env;
    beforeEach(() => { env = mockEnv(); });

    it('register rejects an invalid email with 400 before creating an account', async () => {
        const invite = await issueInvite(env);
        await expectReject(
            handleRegister(post({ ...PERSON, email: 'notanemail', inviteCode: invite.code }), env),
            400,
            /invalid email/i,
        );
        expect([...env.TENNIS_CACHE._store.keys()].some(k => k.startsWith('_user:'))).toBe(false);
        expect(env.DB._tables.invites[0].uses).toBe(0);
    });

    it('login rejects an invalid email with 400 (not a credential 401)', async () => {
        await expectReject(
            handleLogin(post({ email: 'nodomain@', password: 'secret1' }), env),
            400,
            /invalid email/i,
        );
    });

    it('register + login set a cookie session and ignore Authorization', async () => {
        const invite = await issueInvite(env);
        const registered = await handleRegister(post({ ...PERSON, email: 'ada@example.com', inviteCode: invite.code }), env);
        const first = sessionFrom(registered);
        const firstId = first.id;
        const firstCookie = first.pair;
        expect(firstId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(firstCookie.startsWith('__Host-tw_session=')).toBe(true);
        expect(registered.user.email).toBe('ada@example.com');
        expect(registered.user.member).toBe(true);
        expect(registered.user.sessions).toBeUndefined();
        expect(registered.user.passwordHash).toBeUndefined();
        expect(registered.token).toBeUndefined();
        expect(await env.TENNIS_CACHE.get(`_sess2:${firstId}`, 'json')).toMatchObject({ v: 2, email: 'ada@example.com' });
        expect([...env.TENNIS_CACHE._store.keys()].some(k => k.startsWith('_session:'))).toBe(false);

        const me = await handleMe(get({ cookie: firstCookie }), env);
        expect(me.email).toBe('ada@example.com');
        expect(await getAuthUser(get({ authorization: `Bearer ${firstId}` }), env)).toBeNull();

        const loggedIn = await handleLogin(post({ email: 'Ada@Example.com', password: 'secret1' }), env);
        const second = sessionFrom(loggedIn);
        const secondId = second.id;
        expect(secondId).not.toBe(firstId);
        expect(await getAuthUser(get({ cookie: second.pair }), env)).toMatchObject({ email: 'ada@example.com' });
        expect(await env.TENNIS_CACHE.get(`_sess2:${secondId}`, 'json')).toMatchObject({ v: 2 });
    });

    it('ignores a legacy _session: record presented as the cookie', async () => {
        const legacy = 'legacy-token-value1';
        await env.TENNIS_CACHE.put(`_session:${legacy}`, JSON.stringify({
            email: 'ada@example.com',
            expiresAt: Date.now() + 60_000,
        }));
        expect(await getAuthUser(get({ cookie: `__Host-tw_session=${legacy}` }), env)).toBeNull();
        expect(await env.TENNIS_CACHE.get(`_session:${legacy}`, 'json')).toMatchObject({ email: 'ada@example.com' });
    });

    it('change-password revokes every existing session', async () => {
        const invite = await issueInvite(env);
        const a = await handleRegister(post({ ...PERSON, email: 'ada@example.com', inviteCode: invite.code }), env);
        const b = await handleLogin(post({ email: 'ada@example.com', password: 'secret1' }), env);
        const aId = sessionFrom(a).id;
        const bId = sessionFrom(b).id;
        const aCookie = `__Host-tw_session=${aId}`;
        const bCookie = `__Host-tw_session=${bId}`;

        const stored = await env.TENNIS_CACHE.get('_user:ada@example.com', 'json');
        expect(stored.sessions).toEqual(expect.arrayContaining([aId, bId]));
        expect(stored.sessions).toHaveLength(2);

        const result = await handleChangePassword(
            post({ currentPassword: 'secret1', newPassword: 'secret2' }, { cookie: aCookie }),
            env,
        );
        expect(result).toEqual({});

        await expectReject(handleMe(get({ cookie: aCookie }), env), 401, /unauthorized/i);
        await expectReject(handleMe(get({ cookie: bCookie }), env), 401, /unauthorized/i);
        expect(await getAuthUser(get({ cookie: aCookie }), env)).toBeNull();
        expect(await env.TENNIS_CACHE.get(`_sess2:${aId}`, 'json')).toBeNull();
        expect(await env.TENNIS_CACHE.get(`_sess2:${bId}`, 'json')).toBeNull();

        const after = await env.TENNIS_CACHE.get('_user:ada@example.com', 'json');
        expect(after.sessions).toEqual([]);

        await expectReject(
            handleLogin(post({ email: 'ada@example.com', password: 'secret1' }), env),
            401,
            /invalid email or password/i,
        );
        const fresh = await handleLogin(post({ email: 'ada@example.com', password: 'secret2' }), env);
        expect(await handleMe(get({ cookie: sessionFrom(fresh).pair }), env)).toMatchObject({ email: 'ada@example.com' });
    });

    it('logout deletes that server session; other sessions stay valid', async () => {
        const invite = await issueInvite(env);
        const a = await handleRegister(post({ ...PERSON, email: 'ada@example.com', inviteCode: invite.code }), env);
        const b = await handleLogin(post({ email: 'ada@example.com', password: 'secret1' }), env);
        const aId = sessionFrom(a).id;
        const bId = sessionFrom(b).id;
        await handleLogout(get({ cookie: `__Host-tw_session=${aId}` }), env);

        expect(await env.TENNIS_CACHE.get(`_sess2:${aId}`, 'json')).toBeNull();
        await expectReject(handleMe(get({ cookie: `__Host-tw_session=${aId}` }), env), 401, /unauthorized/i);
        expect(await handleMe(get({ cookie: `__Host-tw_session=${bId}` }), env)).toMatchObject({ email: 'ada@example.com' });

        const stored = await env.TENNIS_CACHE.get('_user:ada@example.com', 'json');
        expect(stored.sessions).toEqual([bId]);
    });
});
