import { describe, expect, it } from 'vitest';
import { transformFixtures } from './index.js';
import {
    START_TIMESTAMP_WINDOW_MS,
    applyFixtureOverlay,
    normalizeFixturesFeed,
    startsAtUtcFromTimestamp,
} from './fixturesFeed.js';

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
            startsAtUtc: '2026-11-05T14:30:00.000Z',
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
            startsAtUtc: '2026-11-06T18:00:00.000Z',
            player1Name: 'Ada',
            player2Name: 'Bob',
        })]);
    });
});

const NOW = new Date('2026-11-16T12:00:00.000Z');
const AS_OF = '2026-11-16T11:49:00.000Z';

function fixture(overrides = {}) {
    return {
        matchKey: '88001',
        tournamentKey: '16745',
        tournamentName: 'Metz',
        date: '2026-11-16',
        time: '',
        startsAtUtc: '',
        status: 'Not Started',
        round: 'Quarter-finals',
        roundId: 9,
        player1Key: '2072',
        player1Name: 'J. Sinner',
        player2Key: '2315',
        player2Name: 'C. Alcaraz',
        winner: '',
        isLive: false,
        setScores: [],
        currentGame: null,
        ...overrides,
    };
}

function overlay(overrides = {}) {
    return {
        matchKey: '88001',
        tournamentKey: '16745',
        roundId: 9,
        player1Key: '2072',
        player2Key: '2315',
        player1Name: 'J. Sinner',
        player2Name: 'C. Alcaraz',
        ...overrides,
    };
}

function merge(row, live, options = {}) {
    const lives = live == null ? [] : (Array.isArray(live) ? live : [live]);
    return applyFixtureOverlay([row], lives, { now: NOW, statusAsOf: AS_OF, ...options })[0];
}

describe('fixture livescore overlay', () => {
    it('fills startsAtUtc from an in-range startTimestamp when the fixture has no clock, and leaves both empty otherwise', () => {
        const ts = NOW.getTime() / 1000 + 90 * 60;
        const filled = merge(fixture(), overlay({
            status: 'Not Started',
            startTimestamp: ts,
            date: '2026-11-16T00:00:00.000Z',
        }));
        expect(filled.startsAtUtc).toBe(new Date(ts * 1000).toISOString());
        expect(filled.status).toBe('Not Started');

        const blank = merge(fixture(), overlay({
            status: 'Not Started',
            date: '2026-11-16T18:00:00.000Z',
        }));
        expect(blank.startsAtUtc).toBe('');

        const clockWins = merge(fixture({ startsAtUtc: '2026-11-16T18:00:00.000Z', time: '18:00' }), overlay({
            startTimestamp: ts,
        }));
        expect(clockWins.startsAtUtc).toBe('2026-11-16T18:00:00.000Z');
    });

    it('startTimestamp outside the 14 day window becomes empty startsAtUtc', () => {
        const day = 24 * 60 * 60 * 1000;
        expect(START_TIMESTAMP_WINDOW_MS).toBe(14 * day);

        const edge = (NOW.getTime() + START_TIMESTAMP_WINDOW_MS) / 1000;
        expect(startsAtUtcFromTimestamp(edge, NOW)).toBe(new Date(NOW.getTime() + START_TIMESTAMP_WINDOW_MS).toISOString());
        expect(startsAtUtcFromTimestamp(edge + 1, NOW)).toBe('');

        const past = (NOW.getTime() - START_TIMESTAMP_WINDOW_MS) / 1000;
        expect(startsAtUtcFromTimestamp(past, NOW)).toBe(new Date(NOW.getTime() - START_TIMESTAMP_WINDOW_MS).toISOString());
        expect(startsAtUtcFromTimestamp(past - 1, NOW)).toBe('');

        // Already milliseconds, still inside the window.
        expect(startsAtUtcFromTimestamp(NOW.getTime() + 60_000, NOW))
            .toBe(new Date(NOW.getTime() + 60_000).toISOString());
        expect(startsAtUtcFromTimestamp(NOW.getTime() + START_TIMESTAMP_WINDOW_MS + 1000, NOW)).toBe('');

        for (const bad of ['1730000000', '2026-11-16T18:00:00.000Z', null, undefined, true, false, Number.NaN, Infinity, {}, []]) {
            expect(startsAtUtcFromTimestamp(bad, NOW)).toBe('');
        }

        const row = merge(fixture(), overlay({
            startTimestamp: edge + 20 * 24 * 60 * 60,
            status: 'Not Started',
        }));
        expect(row.startsAtUtc).toBe('');
        expect(row.statusAsOf).toBe(AS_OF);
    });

    it('merges a live event by matchKey and a result by the p1-p2-tournament-round composite', () => {
        const live = merge(fixture(), overlay({
            status: 'Live',
            isLive: true,
            setScores: ['6-4', '3-2'],
            currentGame: '30 - 15',
        }));
        expect(live).toMatchObject({
            status: 'Live',
            isLive: true,
            setScores: ['6-4', '3-2'],
            currentGame: '30 - 15',
            winner: '',
            statusAsOf: AS_OF,
        });

        const byComposite = merge(fixture(), {
            matchKey: '2072-2315-16745-9',
            player1Key: '2315',
            player2Key: '2072',
            tournamentKey: '16745',
            roundId: 9,
            status: 'Finished',
            winner: 'player2',
            setScores: ['6-4', '6-2'],
        });
        expect(byComposite).toMatchObject({
            matchKey: '88001',
            status: 'Finished',
            isLive: false,
            winner: '2072',
            setScores: ['6-4', '6-2'],
        });
    });

    it('keeps a finished result over a later Not Started fixture, and never emits Finished without a winner', () => {
        const finished = merge(fixture(), overlay({
            status: 'Finished',
            winner: '2072',
            setScores: ['7-6', '6-4'],
        }));
        expect(finished).toMatchObject({
            status: 'Finished',
            isLive: false,
            winner: '2072',
            setScores: ['7-6', '6-4'],
        });

        const sticky = merge(finished, overlay({ status: 'Not Started', isLive: false, setScores: [] }));
        expect(sticky).toMatchObject({
            status: 'Finished',
            isLive: false,
            winner: '2072',
            setScores: ['7-6', '6-4'],
        });

        const noWinner = merge(fixture(), overlay({
            status: 'Finished',
            statusText: 'Finished',
            winner: '',
            setScores: ['6-4', '3-3'],
        }));
        expect(noWinner.status).toBe('Live');
        expect(noWinner.status).not.toBe('Finished');
        expect(noWinner.isLive).toBe(true);
        expect(noWinner.winner).toBe('');
        expect(noWinner.setScores).toEqual(['6-4', '3-3']);

        const stayDelayed = merge(fixture({ status: 'Delayed' }), overlay({
            status: 'Finished',
            winner: '',
            setScores: ['6-4'],
        }));
        expect(stayDelayed.status).toBe('Delayed');
        expect(stayDelayed.isLive).toBe(false);
    });

    it('a Live row does not regress to Not Started or Delayed', () => {
        const live = fixture({
            status: 'Live',
            isLive: true,
            setScores: ['6-4', '2-2'],
            currentGame: '15 - 0',
        });
        expect(merge(live, overlay({ status: 'Not Started', isLive: false })).status).toBe('Live');
        expect(merge(live, overlay({ status: 'Upcoming' })).isLive).toBe(true);
        expect(merge(live, overlay({ status: 'Delayed' })).status).toBe('Live');
        expect(merge(fixture({ status: 'Delayed' }), overlay({ status: 'Not Started' })).status).toBe('Delayed');
        expect(merge(fixture({ status: 'Cancelled' }), overlay({
            status: 'Live',
            isLive: true,
            setScores: ['1-0'],
        }))).toMatchObject({ status: 'Cancelled', isLive: false, setScores: [] });
    });

    it('maps walkover and retired ahead of the no-score rule', () => {
        const noScores = merge(fixture(), overlay({
            status: 'Finished',
            winner: '2315',
            setScores: [],
        }));
        expect(noScores).toMatchObject({ status: 'Walkover', winner: '2315', setScores: [], isLive: false });

        const textWalkover = merge(fixture(), overlay({
            status: 'Finished',
            statusText: 'Walkover',
            winner: '2072',
            setScores: ['6-0', '6-0'],
        }));
        expect(textWalkover).toMatchObject({ status: 'Walkover', winner: '2072', setScores: [] });

        const retiredBare = merge(fixture(), overlay({
            status: 'Retired',
            winner: '2072',
            setScores: [],
        }));
        expect(retiredBare.status).toBe('Finished');
        expect(retiredBare.status).not.toBe('Walkover');
        expect(retiredBare.winner).toBe('2072');

        const retiredSets = merge(fixture(), overlay({
            statusText: 'Retired',
            status: 'Finished',
            winner: 'player1',
            setScores: ['6-4', '3-1'],
        }));
        expect(retiredSets).toMatchObject({
            status: 'Finished',
            winner: '2072',
            setScores: ['6-4', '3-1'],
            isLive: false,
        });

        const retiredNoWinner = merge(fixture(), overlay({
            status: 'Retired',
            setScores: ['6-4'],
            winner: '',
        }));
        expect(retiredNoWinner.status).toBe('Live');
        expect(retiredNoWinner.status).not.toBe('Finished');
    });

    it('upgrades an inferred walkover to Finished when scores arrive, in either order', () => {
        const inferred = overlay({
            status: 'Finished',
            winner: '2072',
            setScores: [],
        });
        const scored = overlay({
            status: 'Finished',
            winner: '2072',
            setScores: ['6-4', '6-3'],
        });
        const scoresFirst = merge(fixture(), [scored, inferred]);
        const guessFirst = merge(fixture(), [inferred, scored]);
        expect(scoresFirst).toMatchObject({
            status: 'Finished',
            winner: '2072',
            setScores: ['6-4', '6-3'],
            isLive: false,
        });
        expect(guessFirst).toMatchObject({
            status: 'Finished',
            winner: '2072',
            setScores: ['6-4', '6-3'],
            isLive: false,
        });

        const firstSight = merge(fixture(), inferred);
        expect(firstSight.status).toBe('Walkover');
        const later = merge(firstSight, scored);
        expect(later).toMatchObject({ status: 'Finished', setScores: ['6-4', '6-3'], winner: '2072' });
    });

    it('keeps a feed-text walkover sticky when scores arrive, in either order', () => {
        const named = overlay({
            status: 'Finished',
            statusText: 'Walkover (W/O)',
            winner: '2072',
            setScores: [],
        });
        const scored = overlay({
            status: 'Finished',
            winner: '2072',
            setScores: ['6-4', '6-2'],
        });
        expect(merge(fixture(), [named, scored]).status).toBe('Walkover');
        expect(merge(fixture(), [scored, named])).toMatchObject({ status: 'Walkover', setScores: [] });
        const stuck = merge(merge(fixture(), named), scored);
        expect(stuck.status).toBe('Walkover');
        expect(stuck.setScores).toEqual([]);
    });

    it('classifies real-world status text by precedence', () => {
        const table = [
            ['Retired - player1', { winner: '2072', setScores: ['6-4', '1-0'] }, 'Finished', ['6-4', '1-0']],
            ['Walkover (W/O)', { winner: '2072', setScores: ['6-0', '6-0'] }, 'Walkover', []],
            ['W/O', { winner: '2072', setScores: [] }, 'Walkover', []],
            ['Ret.', { winner: '2072', setScores: ['6-3', '2-1'] }, 'Finished', ['6-3', '2-1']],
            ['Finished (retired)', { winner: '2072', setScores: ['7-5', '2-1'] }, 'Finished', ['7-5', '2-1']],
            ['Interrupted', {}, 'Delayed', []],
            ['Suspended', {}, 'Delayed', []],
            ['Postponed', {}, 'Delayed', []],
            ['Cancelled', {}, 'Cancelled', []],
            ['Canceled', {}, 'Cancelled', []],
            ['Abandoned', {}, 'Cancelled', []],
            ['Cancelled/Canceled', {}, 'Cancelled', []],
            ['Live - walkover', { winner: '2072', setScores: ['6-4'] }, 'Walkover', []],
            ['Finished - interrupted', { winner: '2072', setScores: ['6-4', '6-4'] }, 'Finished', ['6-4', '6-4']],
        ];
        for (const [text, extra, status, setScores] of table) {
            const row = merge(fixture(), overlay({ status: text, statusText: text, ...extra }));
            expect(row.status, text).toBe(status);
            expect(row.setScores, text).toEqual(setScores);
            expect(row.isLive, text).toBe(false);
        }
    });

    it('serves the fixture unchanged aside from an empty statusAsOf when nothing is cached', () => {
        const row = fixture({ startsAtUtc: '2026-11-16T18:00:00.000Z', time: '18:00' });
        const [out] = applyFixtureOverlay([row], null, { now: NOW, statusAsOf: '' });
        const { statusAsOf, ...rest } = out;
        expect(statusAsOf).toBe('');
        expect(rest).toEqual(row);
    });
});
