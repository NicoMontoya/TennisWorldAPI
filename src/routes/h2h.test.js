import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cache } from '../cache.js';
import { H2H_CACHE_VERSION, handleH2H } from './h2h.js';
import { handleImportMatches } from './adminBackfill.js';
import { writeMatchLog } from './playerMatches.js';

const playerPastMatches = vi.fn();
const calendar = vi.fn();

vi.mock('../apiClient.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        rapidAPI: {
            ...orig.rapidAPI,
            playerPastMatches: (...args) => playerPastMatches(...args),
            calendar: (...args) => calendar(...args),
        },
    };
});

function mockEnv() {
    const store = new Map();
    return {
        ADMIN_SECRET: 'test-admin-secret',
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
            async list({ prefix, cursor, limit = 1000 } = {}) {
                const keys = [...store.keys()]
                    .filter(k => !prefix || k.startsWith(prefix))
                    .sort();
                const start = cursor ? Number(cursor) : 0;
                const slice = keys.slice(start, start + limit);
                const next = start + slice.length;
                return {
                    keys: slice.map(name => ({ name })),
                    list_complete: next >= keys.length,
                    cursor: next < keys.length ? String(next) : undefined,
                };
            },
            _store: store,
        },
    };
}

function h2hReq(a, b) {
    return new Request(`https://example.test/api/h2h?playerKeyA=${a}&playerKeyB=${b}&tour=ATP`);
}

function importReq(logs, { secret } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['x-admin-secret'] = secret;
    return new Request('https://example.test/api/admin/import-matches', {
        method: 'POST',
        headers,
        body: JSON.stringify({ tour: 'ATP', logs }),
    });
}

const ALCARAZ = '68074';
const SINNER  = '47275';

function meeting({ matchKey, date, won, opponentKey, opponentName = 'Opp' }) {
    return {
        matchKey, date, tournamentName: 'Test Open', surface: 'hard', round: 'F',
        opponentKey, opponentName, won, score: '6-4 6-4',
    };
}

describe('H2H cache version + ordered-pair import invalidate', () => {
    let env;
    beforeEach(() => {
        env = mockEnv();
        playerPastMatches.mockResolvedValue({ data: [] });
        calendar.mockResolvedValue({ data: [] });
        globalThis.caches = {
            default: {
                async match() { return undefined; },
                async put() {},
                async delete() { return true; },
            },
        };
    });
    afterEach(() => {
        delete globalThis.caches;
        playerPastMatches.mockReset();
        calendar.mockReset();
    });

    it('uses h2h-v11 so pre-import ordered-pair entries miss after deploy', () => {
        expect(H2H_CACHE_VERSION).toBe('h2h-v11');
    });

    it('rejects import-matches without the admin secret', async () => {
        await expect(handleImportMatches(importReq({ [SINNER]: [] }), env))
            .rejects.toMatchObject({ status: 401 });
    });

    it('unions B\'s log when A\'s match log is empty', async () => {
        await writeMatchLog(env, 'ATP', ALCARAZ, [
            meeting({ matchKey: '1-1', date: '2022-01-01', won: true, opponentKey: SINNER, opponentName: 'Sinner' }),
            meeting({ matchKey: '1-2', date: '2023-01-01', won: false, opponentKey: SINNER, opponentName: 'Sinner' }),
        ]);

        const data = await handleH2H(h2hReq(SINNER, ALCARAZ), env);
        expect(data.h2hMatches).toHaveLength(2);
        expect(data.h2hMatches.map(m => m.matchKey).sort()).toEqual(['1-1', '1-2']);
        expect(data.surfaceSplits.all).toEqual({ p1wins: 1, p2wins: 1 });
        expect(data.h2hMatches.find(m => m.matchKey === '1-1').winner).toBe('Second Player');
        expect(data.h2hMatches.find(m => m.matchKey === '1-2').winner).toBe('First Player');
    });

    it('invalidates A→opponents H2H cache after a successful match-log import', async () => {
        await cache.set(env, 300, { h2hMatches: Array(10).fill({}) }, H2H_CACHE_VERSION, 'ATP', SINNER, ALCARAZ);
        await cache.set(env, 300, { h2hMatches: Array(17).fill({}) }, H2H_CACHE_VERSION, 'ATP', ALCARAZ, SINNER);

        const imported = await handleImportMatches(importReq({
            [SINNER]: [
                meeting({ matchKey: '1-1', date: '2022-01-01', won: false, opponentKey: ALCARAZ, opponentName: 'Alcaraz' }),
            ],
        }, { secret: env.ADMIN_SECRET }), env);

        expect(imported).toMatchObject({ ok: true, written: 1, errors: 0 });
        expect(await cache.get(env, H2H_CACHE_VERSION, 'ATP', SINNER, ALCARAZ)).toBeNull();
        expect((await cache.get(env, H2H_CACHE_VERSION, 'ATP', ALCARAZ, SINNER)).data.h2hMatches).toHaveLength(17);
    });
});
