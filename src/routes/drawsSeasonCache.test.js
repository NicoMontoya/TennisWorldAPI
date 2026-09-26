import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleDraws } from './draws.js';
import { buildOfficialRecord, officialDrawKvKey } from '../officialDraw.js';

const tournamentResults = vi.fn();
const tournamentFixtures = vi.fn();
const tournamentInfo = vi.fn();
const rankingsPaged = vi.fn();

vi.mock('../apiClient.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        rapidAPI: {
            ...orig.rapidAPI,
            tournamentResults: (...args) => tournamentResults(...args),
            tournamentFixtures: (...args) => tournamentFixtures(...args),
            tournamentInfo: (...args) => tournamentInfo(...args),
            rankingsPaged: (...args) => rankingsPaged(...args),
        },
    };
});

function match(id, p1, p2) {
    return {
        id,
        date: '2026-09-20',
        roundId: 7,
        player1Id: p1,
        player2Id: p2,
        match_winner: p1,
        result: '6-4 6-3',
        player1: { name: `Player ${p1}` },
        player2: { name: `Player ${p2}` },
    };
}

function mockEnv() {
    const store = new Map();
    const puts = [];
    const gets = [];
    return {
        puts,
        gets,
        TENNIS_CACHE: {
            async get(key, type) {
                gets.push(key);
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json' || type?.type === 'json') {
                    try { return JSON.parse(raw); } catch { return raw; }
                }
                return raw;
            },
            async put(key, value) {
                puts.push(key);
                store.set(key, value);
            },
            async delete(key) { store.delete(key); },
            _store: store,
        },
    };
}

function get(path) {
    return new Request(`https://example.test${path}`);
}

const SLOTS = [['101', '202'], ['303', '404']];

describe('GET /api/draws season is not a cache key', () => {
    beforeEach(() => {
        delete globalThis.caches;
        tournamentResults.mockResolvedValue({
            data: { singles: [match(1, 101, 202), match(2, 303, 404)] },
        });
        tournamentFixtures.mockResolvedValue({ data: [] });
        tournamentInfo.mockResolvedValue({ data: { name: 'Qwertyville Open' } });
        rankingsPaged.mockResolvedValue({ data: [] });
    });
    afterEach(() => { delete globalThis.caches; });

    it('two different season query values share one cache key and write KV once', async () => {
        const env = mockEnv();
        const first = await handleDraws(
            get('/api/draws?tournamentKey=9001&tour=ATP&season=2026'),
            env,
        );
        const putsAfterFirst = env.puts.slice();
        const second = await handleDraws(
            get('/api/draws?tournamentKey=9001&tour=ATP&season=0000'),
            env,
        );

        expect(first.tournamentKey).toBe('9001');
        expect(second.tournamentKey).toBe('9001');
        expect(putsAfterFirst).toEqual([
            'tw:draws14:9001:ATP',
            'tw:draws14:9001:ATP:stale',
        ]);
        expect(env.puts).toEqual(putsAfterFirst);
        expect(env.puts.some(k => /:(2026|0000)/.test(k))).toBe(false);
        expect(tournamentResults).toHaveBeenCalledTimes(1);
        expect(rankingsPaged).toHaveBeenCalledTimes(1);
    });

    it('looks up the official record with the season on the match dates', async () => {
        const built = buildOfficialRecord({
            tournamentKey: '9002',
            season: '2026',
            tour: 'ATP',
            sourceHost: 'atptour.com',
            checkedAt: '2026-09-26',
            slots: SLOTS,
        });
        expect(built.ok, built.error).toBe(true);

        const env = mockEnv();
        env.TENNIS_CACHE._store.set(
            officialDrawKvKey('ATP', '9002', '2026'),
            JSON.stringify(built.record),
        );
        const verified = await handleDraws(
            get('/api/draws?tournamentKey=9002&tour=ATP&season=1999'),
            env,
        );
        expect(verified.slotOrderVerified).toBe(true);
        expect(verified.slotOrderVerification).toEqual({
            tour: 'ATP',
            sourceHost: 'atptour.com',
            checkedAt: '2026-09-26',
        });
        expect(env.gets).toContain('tw:official-draw:v1:ATP:9002:2026');
        expect(env.gets.some(k => k.endsWith(':1999'))).toBe(false);

        const disagreeing = mockEnv();
        disagreeing.TENNIS_CACHE._store.set(
            officialDrawKvKey('ATP', '9002', '1999'),
            JSON.stringify({ ...built.record, season: '1999' }),
        );
        const missed = await handleDraws(
            get('/api/draws?tournamentKey=9002&tour=ATP&season=1999'),
            disagreeing,
        );
        expect(missed.slotOrderVerified).toBe(false);
        expect(missed.slotOrderVerification).toBeUndefined();
        expect(disagreeing.gets).toContain('tw:official-draw:v1:ATP:9002:2026');
        expect(disagreeing.gets).not.toContain('tw:official-draw:v1:ATP:9002:1999');
    });
});
