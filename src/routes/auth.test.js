import { describe, it, expect, beforeEach } from 'vitest';
import {
    isValidEmail,
    handleRegister,
    handleLogin,
    handleLogout,
    handleMe,
    handleChangePassword,
    getAuthUser,
} from './auth.js';

function mockEnv() {
    const store = new Map();
    return {
        TENNIS_CACHE: {
            async get(key, type) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json') return JSON.parse(raw);
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

function post(body, { token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request('https://example.test/api/auth', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

function get({ token } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request('https://example.test/api/auth/me', { headers });
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
        await expectReject(
            handleRegister(post({ ...PERSON, email: 'notanemail' }), env),
            400,
            /invalid email/i,
        );
        expect([...env.TENNIS_CACHE._store.keys()].some(k => k.startsWith('_user:'))).toBe(false);
    });

    it('login rejects an invalid email with 400 (not a credential 401)', async () => {
        await expectReject(
            handleLogin(post({ email: 'nodomain@', password: 'secret1' }), env),
            400,
            /invalid email/i,
        );
    });

    it('register + login succeed for a valid email and issue a working Bearer token', async () => {
        const registered = await handleRegister(post({ ...PERSON, email: 'ada@example.com' }), env);
        expect(registered.token).toMatch(/^[0-9a-f-]{36}$/i);
        expect(registered.user.email).toBe('ada@example.com');
        expect(registered.user.sessions).toBeUndefined();

        const me = await handleMe(get({ token: registered.token }), env);
        expect(me.email).toBe('ada@example.com');

        const loggedIn = await handleLogin(post({ email: 'Ada@Example.com', password: 'secret1' }), env);
        expect(await getAuthUser(get({ token: loggedIn.token }), env)).toMatchObject({ email: 'ada@example.com' });
    });

    it('change-password revokes every existing session so old Bearers 401', async () => {
        const a = await handleRegister(post({ ...PERSON, email: 'ada@example.com' }), env);
        const b = await handleLogin(post({ email: 'ada@example.com', password: 'secret1' }), env);

        const stored = await env.TENNIS_CACHE.get('_user:ada@example.com', 'json');
        expect(stored.sessions).toEqual(expect.arrayContaining([a.token, b.token]));
        expect(stored.sessions).toHaveLength(2);

        const result = await handleChangePassword(
            post({ currentPassword: 'secret1', newPassword: 'secret2' }, { token: a.token }),
            env,
        );
        expect(result).toEqual({});

        await expectReject(handleMe(get({ token: a.token }), env), 401, /unauthorized/i);
        await expectReject(handleMe(get({ token: b.token }), env), 401, /unauthorized/i);
        expect(await getAuthUser(get({ token: a.token }), env)).toBeNull();
        expect(await env.TENNIS_CACHE.get(`_session:${a.token}`, 'json')).toBeNull();
        expect(await env.TENNIS_CACHE.get(`_session:${b.token}`, 'json')).toBeNull();

        const after = await env.TENNIS_CACHE.get('_user:ada@example.com', 'json');
        expect(after.sessions).toEqual([]);

        await expectReject(
            handleLogin(post({ email: 'ada@example.com', password: 'secret1' }), env),
            401,
            /invalid email or password/i,
        );
        const fresh = await handleLogin(post({ email: 'ada@example.com', password: 'secret2' }), env);
        expect(await handleMe(get({ token: fresh.token }), env)).toMatchObject({ email: 'ada@example.com' });
    });

    it('logout drops only that session; other sessions stay valid until password change', async () => {
        const a = await handleRegister(post({ ...PERSON, email: 'ada@example.com' }), env);
        const b = await handleLogin(post({ email: 'ada@example.com', password: 'secret1' }), env);
        await handleLogout(get({ token: a.token }), env);

        await expectReject(handleMe(get({ token: a.token }), env), 401, /unauthorized/i);
        expect(await handleMe(get({ token: b.token }), env)).toMatchObject({ email: 'ada@example.com' });

        const stored = await env.TENNIS_CACHE.get('_user:ada@example.com', 'json');
        expect(stored.sessions).toEqual([b.token]);
    });
});
