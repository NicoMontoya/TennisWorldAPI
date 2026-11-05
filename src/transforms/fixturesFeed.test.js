import { describe, expect, it } from 'vitest';
import { transformFixtures } from './index.js';
import { normalizeFixturesFeed } from './fixturesFeed.js';

// RapidAPI fixtures are `{ data: [{ id, date, tournament, player1, ... }] }`.
// The api-tennis normalizer reads event_key / event_date / tournament_name,
// so every row comes back with those fields blank. Livescore and hub unwrap
// `.data` and read `id` instead.
const rapidRow = {
    id: 88001,
    matchId: 88001,
    date: '2026-11-05T14:30:00.000Z',
    roundId: 9,
    round: { id: 9, name: '1/4' },
    tournamentId: 16745,
    tournament: { id: 16745, name: 'Metz' },
    player1Id: 2072,
    player2Id: 2315,
    player1: { id: 2072, name: 'J. Sinner' },
    player2: { id: 2315, name: 'C. Alcaraz' },
};

describe('normalizeFixturesFeed', () => {
    it('maps a RapidAPI envelope to real keys and drops rows that still have none', () => {
        const envelope = {
            data: [rapidRow, { player1: { name: 'Ghost' }, player2: { name: 'Nobody' } }],
            hasNextPage: false,
        };

        const [blank] = transformFixtures(envelope.data);
        expect(blank.matchKey).toBe('');
        expect(blank.tournamentKey).toBe('');
        expect(blank.tournamentName).toBe('');
        expect(blank.date).toBe('');
        expect(blank.time).toBe('');
        expect(blank.status).toBe('');
        expect(blank.round).toBe('');

        const rows = normalizeFixturesFeed(envelope, { tour: 'ATP' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            matchKey: '88001',
            tournamentKey: '16745',
            tournamentName: 'Metz',
            date: '2026-11-05',
            time: '14:30',
            status: 'Not Started',
            round: 'Quarter-finals',
            player1Key: '2072',
            player1Name: 'J. Sinner',
            player2Key: '2315',
            player2Name: 'C. Alcaraz',
        });
    });

    it('uses the tournament id from a per-tournament fixtures list that has no nested tournament', () => {
        const rows = normalizeFixturesFeed({
            data: [{
                id: 555,
                roundId: 12,
                player1Id: 1,
                player2Id: 2,
                player1: { name: 'Ada' },
                player2: { name: 'Bob' },
                date: '2026-11-06T18:00:00.000Z',
            }],
        }, { tour: 'WTA', tournamentKey: '42', tournamentName: 'Finals' });
        expect(rows).toEqual([expect.objectContaining({
            matchKey: '555',
            tournamentKey: '42',
            tournamentName: 'Finals',
            round: 'Final',
            date: '2026-11-06',
            time: '18:00',
            player1Name: 'Ada',
            player2Name: 'Bob',
        })]);
    });
});
