import { describe, it, expect, beforeEach } from 'vitest';
import {
    RL_PER_MINUTE,
    TOURNAMENT_KEY_RE,
    parseTour,
    parseTournamentKey,
    rateLimit,
} from './security.js';

function mockEnv() {
    const store = new Map();
    return {
        TENNIS_CACHE: {
            async get(key) {
                return store.has(key) ? store.get(key) : null;
            },
            async put(key, value) {
                store.set(key, value);
            },
            _store: store,
        },
    };
}

function req(url = 'https://example.test/api/livescore', ip) {
    const headers = {};
    if (ip) headers['CF-Connecting-IP'] = ip;
    return new Request(url, { headers });
}

async function expectReject(promise, status, messageRe) {
    await expect(promise).rejects.toMatchObject({
        status,
        message: expect.stringMatching(messageRe),
    });
}

describe('parseTour', () => {
    it('defaults omitted / blank to ATP and accepts ATP|WTA case-insensitively', () => {
        expect(parseTour(null)).toBe('ATP');
        expect(parseTour(undefined)).toBe('ATP');
        expect(parseTour('')).toBe('ATP');
        expect(parseTour('  ')).toBe('ATP');
        expect(parseTour('atp')).toBe('ATP');
        expect(parseTour('WTA')).toBe('WTA');
        expect(parseTour(' wta ')).toBe('WTA');
    });

    it('rejects junk tour values with 400 so they cannot fan cache keys', () => {
        for (const junk of ['ITF', 'ATP2', 'ALL', 'atp;WTA', '../ATP', 'ATP WTA']) {
            try {
                parseTour(junk);
                expect.unreachable(`expected 400 for ${junk}`);
            } catch (err) {
                expect(err.status).toBe(400);
                expect(err.message).toMatch(/ATP or WTA/i);
            }
        }
    });
});

describe('parseTournamentKey', () => {
    it('accepts 1–20 digit keys and treats absent optional as undefined', () => {
        expect(TOURNAMENT_KEY_RE.test('123')).toBe(true);
        expect(parseTournamentKey(null)).toBeUndefined();
        expect(parseTournamentKey(undefined)).toBeUndefined();
        expect(parseTournamentKey('123')).toBe('123');
        expect(parseTournamentKey(' 007 ')).toBe('007');
        expect(parseTournamentKey('1'.repeat(20))).toBe('1'.repeat(20));
    });

    it('rejects empty junk, non-digits, and oversized keys with 400', () => {
        for (const junk of ['', '   ', 'abc', '12ab', '12-34', '12.3', '-1', '1'.repeat(21)]) {
            try {
                parseTournamentKey(junk);
                expect.unreachable(`expected 400 for ${JSON.stringify(junk)}`);
            } catch (err) {
                expect(err.status).toBe(400);
            }
        }
    });

    it('required: missing/empty → 400 (not 500)', () => {
        try { parseTournamentKey(null, { required: true }); expect.unreachable(); }
        catch (err) { expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/required/i) }); }
        try { parseTournamentKey('', { required: true }); expect.unreachable(); }
        catch (err) { expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/required/i) }); }
    });
});

describe('rateLimit', () => {
    let env;
    beforeEach(() => { env = mockEnv(); });

    it('uses _rl:${bucket}:${ip} and allows exactly max ticks in the window', async () => {
        const r = req('https://example.test/api/hub', '203.0.113.9');
        for (let i = 0; i < RL_PER_MINUTE.max; i++) {
            await rateLimit(env, r, 'hub');
        }
        expect(env.TENNIS_CACHE._store.get('_rl:hub:203.0.113.9')).toBe(String(RL_PER_MINUTE.max));
        await expectReject(rateLimit(env, r, 'hub'), 429, /too many requests/i);
        expect(env.TENNIS_CACHE._store.get('_rl:hub:203.0.113.9')).toBe(String(RL_PER_MINUTE.max + 1));
    });

    it('isolates buckets and IPs (hub vs livescore, local fallback)', async () => {
        const a = req('https://example.test/api/hub', '198.51.100.1');
        const b = req('https://example.test/api/livescore', '198.51.100.1');
        const c = req('https://example.test/api/hub'); // no CF-Connecting-IP → local
        await rateLimit(env, a, 'hub');
        await rateLimit(env, b, 'livescore');
        await rateLimit(env, c, 'hub');
        expect([...env.TENNIS_CACHE._store.keys()].sort()).toEqual([
            '_rl:hub:198.51.100.1',
            '_rl:hub:local',
            '_rl:livescore:198.51.100.1',
        ]);
    });

    it('fails closed with 429 when KV is missing or get/put throws', async () => {
        const r = req();
        await expectReject(rateLimit({}, r, 'livescore'), 429, /too many requests/i);
        await expectReject(
            rateLimit({
                TENNIS_CACHE: {
                    async get() { throw new Error('kv down'); },
                    async put() {},
                },
            }, r, 'livescore'),
            429,
            /too many requests/i,
        );
    });
});
