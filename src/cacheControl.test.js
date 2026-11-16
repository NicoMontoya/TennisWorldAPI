import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from './index.js';
import { createMemoryD1 } from './d1Memory.js';

const PRIVATE = 'private, no-store';

function mockEnv() {
    const store = new Map();
    return {
        CORS_ORIGIN: '*',
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
            response.headers.forEach((v, k) => { headers[k] = v; });
            store.set(url, { body: await response.clone().text(), headers });
        },
    };
    globalThis.caches = { default: cache };
    return cache;
}

function req(path, { method = 'GET', body, token, cookie, ip, secret, origin } = {}) {
    const url = `https://example.test${path}`;
    const headers = {};
    if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        if (origin !== null) headers.Origin = origin || new URL(url).origin;
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (ip) headers['CF-Connecting-IP'] = ip;
    if (secret) headers['x-admin-secret'] = secret;
    return new Request(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function cookiePair(response) {
    const lines = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    const line = lines.find(value => value && value.startsWith('__Host-tw_session=')) || '';
    return line.split(';')[0];
}

async function expectPrivate(response, status) {
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe(PRIVATE);
    expect(response.headers.get('Content-Type')).toBe('application/json');
}

describe('per-user Cache-Control', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        installMockCaches();
    });
    afterEach(() => { delete globalThis.caches; });

    it('sets private, no-store on unauthenticated session routes (401)', async () => {
        const cases = [
            ['GET', '/api/bracket/mine'],
            ['POST', '/api/bracket/save'],
            ['GET', '/api/bracket/leaders'],
            ['GET', '/api/bracket/public'],
            ['GET', '/api/auth/me'],
            ['POST', '/api/auth/update-profile'],
            ['POST', '/api/auth/change-password'],
            ['GET', '/api/favorites'],
            ['POST', '/api/favorites/toggle'],
        ];
        for (const [method, path] of cases) {
            const res = await worker.fetch(req(path, { method }), env);
            expect(res.status, path).toBe(401);
            expect(res.headers.get('Cache-Control'), path).toBe(PRIVATE);
        }
    });

    it('sets the header on login/register errors, including 429 and 500', async () => {
        const badLogin = await worker.fetch(req('/api/auth/login', {
            method: 'POST',
            body: { email: 'not-an-email', password: 'secret1' },
        }), env);
        await expectPrivate(badLogin, 400);

        env.TENNIS_CACHE._store.set('_rl:auth:203.0.113.9', '10');
        const limited = await worker.fetch(req('/api/auth/login', {
            method: 'POST',
            body: { email: 'ada@example.com', password: 'secret1' },
            ip: '203.0.113.9',
        }), env);
        await expectPrivate(limited, 429);

        const broken = mockEnv();
        broken.TENNIS_CACHE.get = async () => { throw new Error('kv down'); };
        const crashed = await worker.fetch(req('/api/bracket/mine', {
            cookie: '__Host-tw_session=not-a-session-token',
        }), broken);
        await expectPrivate(crashed, 500);
        expect(await crashed.json()).toEqual({ ok: false, error: 'kv down' });

        const saveCrashed = await worker.fetch(req('/api/bracket/save', {
            method: 'POST',
            cookie: '__Host-tw_session=not-a-session-token',
            body: {},
        }), broken);
        await expectPrivate(saveCrashed, 500);
    });

    it('sets the header on successful register, me, favorites, and bracket/mine', async () => {
        env.ADMIN_SECRET = 'test-admin-secret';
        const invited = await worker.fetch(req('/api/admin/invites', {
            method: 'POST',
            body: {},
            secret: 'test-admin-secret',
        }), env);
        expect(invited.status).toBe(200);
        const invite = await invited.json();

        const registered = await worker.fetch(req('/api/auth/register', {
            method: 'POST',
            body: {
                firstName: 'Ada',
                lastName: 'Lovelace',
                email: 'ada@example.com',
                password: 'secret1',
                inviteCode: invite.data.code,
            },
        }), env);
        await expectPrivate(registered, 200);
        const cookie = cookiePair(registered);
        expect(cookie.startsWith('__Host-tw_session=')).toBe(true);

        const me = await worker.fetch(req('/api/auth/me', { cookie }), env);
        await expectPrivate(me, 200);

        const favorites = await worker.fetch(req('/api/favorites', { cookie }), env);
        await expectPrivate(favorites, 200);

        const mine = await worker.fetch(req('/api/bracket/mine', { cookie }), env);
        await expectPrivate(mine, 200);
        expect(await mine.json()).toEqual({ ok: true, data: { brackets: [] } });
    });

    it('leaves public routes without Cache-Control', async () => {
        const leaders = await worker.fetch(req('/api/bracket/leaders'), env);
        expect(leaders.status).toBe(401);
        expect(leaders.headers.get('Cache-Control')).toBe(PRIVATE);
        expect(leaders.headers.get('Content-Type')).toBe('application/json');

        const pub = await worker.fetch(req('/api/bracket/public'), env);
        expect(pub.status).toBe(401);
        expect(pub.headers.get('Cache-Control')).toBe(PRIVATE);

        const hub = await worker.fetch(req('/api/hub?tour=ITF'), env);
        expect(hub.status).toBe(400);
        expect(hub.headers.get('Cache-Control')).toBeNull();
        expect(await hub.json()).toEqual({
            ok: false,
            error: expect.stringMatching(/ATP or WTA/i),
        });
    });
});
