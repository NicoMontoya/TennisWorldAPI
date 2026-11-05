import { describe, expect, it } from 'vitest';
import { createMemoryD1 } from './d1Memory.js';
import {
    readFixtures,
    readStandings,
    rememberFixtures,
    rememberStandings,
    reserveD1Writes,
} from './d1Store.js';

function envWith(budget) {
    return {
        DB: createMemoryD1(),
        D1_DAILY_WRITE_BUDGET: String(budget),
    };
}

describe('D1 write budget', () => {
    it('stores fixtures by tour + matchKey and stops when the daily budget is spent', async () => {
        const env = envWith(1);
        const first = await rememberFixtures(env, 'ATP', [
            { matchKey: '1', tournamentKey: '9', date: '2026-11-05', player1Name: 'A' },
            { matchKey: '2', tournamentKey: '9', date: '2026-11-05', player2Name: 'B' },
        ]);
        expect(first.written).toBe(1);
        expect(first.budget).toBe(true);
        expect(env.DB._tables.fixtures).toHaveLength(1);
        expect(env.DB._tables.fixtures[0].match_key).toBe('1');

        const again = await rememberFixtures(env, 'ATP', [
            { matchKey: '3', tournamentKey: '9', date: '2026-11-06' },
        ]);
        expect(again.written).toBe(0);
        expect(again.budget).toBe(true);
        expect(env.DB._tables.fixtures).toHaveLength(1);

        const saved = await readFixtures(env, { tour: 'ATP', tournamentKey: '9' });
        expect(saved.rows.map(row => row.matchKey)).toEqual(['1']);
        expect(saved.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('does not replace a standings set when the whole pull does not fit', async () => {
        const env = envWith(1);
        const skipped = await rememberStandings(env, 'ATP', [
            { playerKey: '10', rank: 1, name: 'A' },
            { playerKey: '11', rank: 2, name: 'B' },
        ], { replace: true });
        expect(skipped.written).toBe(0);
        expect(await reserveD1Writes(env, 1)).toBe(1);
        expect(env.DB._tables.standings).toHaveLength(0);
    });

    it('upserts the same matchKey instead of inserting a second row', async () => {
        const env = envWith(10);
        await rememberFixtures(env, 'ATP', [
            {
                matchKey: '7',
                tournamentKey: '1',
                date: '2026-11-05',
                time: '14:30',
                startsAtUtc: '2026-11-05T14:30:00.000Z',
                player1Name: 'Old',
            },
        ]);
        await rememberFixtures(env, 'ATP', [
            {
                matchKey: '7',
                tournamentKey: '1',
                date: '2026-11-05',
                startsAtUtc: '2026-11-05T14:30:00.000Z',
                player1Name: 'New',
            },
        ]);
        expect(env.DB._tables.fixtures).toHaveLength(1);
        const saved = await readFixtures(env, { tour: 'ATP' });
        expect(saved.rows[0].player1Name).toBe('New');
        expect(env.DB._tables.fixtures[0].starts_at_utc).toBe('2026-11-05T14:30:00.000Z');
    });

    it('does not erase saved fixtures when the new list is empty', async () => {
        const env = envWith(10);
        await rememberFixtures(env, 'ATP', [
            { matchKey: '1', tournamentKey: '21362', date: '2026-11-06', player1Name: 'A' },
        ]);
        const empty = await rememberFixtures(env, 'ATP', []);
        expect(empty).toEqual({ written: 0 });
        expect(env.DB._tables.fixtures).toHaveLength(1);
        const saved = await readFixtures(env, { tour: 'ATP', tournamentKey: '21362' });
        expect(saved.rows.map(row => row.matchKey)).toEqual(['1']);
    });
});
