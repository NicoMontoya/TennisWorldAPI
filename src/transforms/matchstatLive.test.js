import { describe, it, expect } from 'vitest';
import {
    parseMatchId,
    parseLiveScore,
    parseCurrentGame,
    mapLiveStatus,
    liveEventMatchesTour,
    isLowerTierNoise,
    filterLiveEvents,
    resolveMatchKey,
    mapLiveEvent,
    mergeLiveOverBoard,
    applyLiveOverlayToHub,
    indexCoreMatches,
    unwrapLiveEvents,
    dedupeBoardByPair,
    applyStickyCompletions,
    markPastStartUnplayed,
    isPastScheduledStart,
    snapshotSeenLive,
    completedSetChanged,
    rowPairKey,
} from './matchstatLive.js';

const inPlay = {
    id: '3815731',
    name: 'J. Sinner vs C. Alcaraz',
    participant1: 'J. Sinner',
    participant2: 'C. Alcaraz',
    league: 'US Open',
    score: '6-4, 3-2',
    status: 'InPlay',
    points: '30-15',
    tourType: 'ATP',
    startTimestamp: 1757180000,
    matchId: '2072-2315-20340-12',
};

describe('parseMatchId', () => {
    it('splits {p1}-{p2}-{tournamentId}-{roundId}', () => {
        expect(parseMatchId('45191-59913-17112-12')).toEqual({
            player1Id: '45191',
            player2Id: '59913',
            tournamentId: '17112',
            roundId: 12,
        });
    });

    it('rejects missing, non-numeric, or wrong-arity ids', () => {
        expect(parseMatchId(null)).toBeNull();
        expect(parseMatchId('2072-2315-20340')).toBeNull();
        expect(parseMatchId('2072-2315-20340-12-9')).toBeNull();
        expect(parseMatchId('p1-p2-20340-12')).toBeNull();
    });
});

describe('parseLiveScore / parseCurrentGame / mapLiveStatus', () => {
    it('splits comma or space set scores and keeps tiebreak tokens', () => {
        expect(parseLiveScore('6-4, 3-2')).toEqual(['6-4', '3-2']);
        expect(parseLiveScore('6-4 7-6 (7-3)')).toEqual(['6-4', '7-6(7-3)']);
        expect(parseLiveScore('')).toEqual([]);
        expect(parseLiveScore(null)).toEqual([]);
    });

    it('normalizes points to currentGame', () => {
        expect(parseCurrentGame('30-15')).toBe('30 - 15');
        expect(parseCurrentGame('40 - 40')).toBe('40 - 40');
        expect(parseCurrentGame('')).toBeNull();
        expect(parseCurrentGame(null)).toBeNull();
    });

    it('maps InPlay to isLive and leaves Upcoming/Finished idle', () => {
        expect(mapLiveStatus('InPlay')).toEqual({ isLive: true, status: 'Live' });
        expect(mapLiveStatus('in_play')).toEqual({ isLive: true, status: 'Live' });
        expect(mapLiveStatus('Upcoming')).toEqual({ isLive: false, status: 'Not Started' });
        expect(mapLiveStatus('Finished')).toEqual({ isLive: false, status: 'Finished' });
    });
});

describe('tour + lower-tier filter', () => {
    it('keeps ATP / ATP Singles and drops WTA, ITF, Challenger', () => {
        expect(liveEventMatchesTour({ tourType: 'ATP' }, 'ATP')).toBe(true);
        expect(liveEventMatchesTour({ tourType: 'ATP Singles' }, 'ATP')).toBe(true);
        expect(liveEventMatchesTour({ tourType: 'WTA' }, 'ATP')).toBe(false);
        expect(liveEventMatchesTour({ tourType: 'ATP Challenger' }, 'ATP')).toBe(false);
        expect(liveEventMatchesTour({ tourType: 'ITF' }, 'ATP')).toBe(false);
        expect(liveEventMatchesTour({ tourType: 'Challenger' }, 'ATP')).toBe(false);
        expect(isLowerTierNoise({ tourType: 'ATP', league: 'ATP Challenger Cary' })).toBe(true);
        expect(isLowerTierNoise({ tourType: 'ATP', league: 'US Open' })).toBe(false);
        expect(isLowerTierNoise({ tourType: 'ATP', league: 'M25 Idanha-a-Nova' })).toBe(true);
        expect(isLowerTierNoise({ tourType: 'WTA', league: 'W15 Santa Tecla' })).toBe(true);
        expect(isLowerTierNoise({ tourType: 'ATP', league: 'M15 Monastir' })).toBe(true);
        expect(isLowerTierNoise({ tourType: 'WTA', league: 'W25 Istanbul' })).toBe(true);
        expect(isLowerTierNoise({ tourType: 'WTA', league: 'WTA 250' })).toBe(false);
        expect(isLowerTierNoise({ tourType: 'ATP', league: 'ATP 250' })).toBe(false);
    });

    it('filterLiveEvents applies tour, tournamentKey, doubles, and calendar main-tour', () => {
        const mixed = [
            inPlay,
            { ...inPlay, id: '2', tourType: 'WTA', matchId: '1-2-3-12' },
            { ...inPlay, id: '3', tourType: 'ITF', matchId: '1-2-3-12' },
            { ...inPlay, id: '4', tourType: 'Challenger', matchId: '1-2-3-12' },
            { ...inPlay, id: '4b', tourType: 'ATP', league: 'M25 Cary', matchId: '1-2-4-12' },
            { ...inPlay, id: '5', participant1: 'A / B', participant2: 'C / D', matchId: '9-8-20340-7' },
            { ...inPlay, id: '6', matchId: '10-20-99-6', league: 'Some 250' },
            { ...inPlay, id: '7', matchId: 'bad' },
        ];
        const calendarById = new Map([
            ['20340', { id: 20340, tier: 'Grand Slam' }],
            ['99', { id: 99, tier: 'ATP Challenger' }],
        ]);
        const kept = filterLiveEvents(mixed, { tour: 'ATP', calendarById });
        expect(kept).toHaveLength(1);
        expect(kept[0].id).toBe('3815731');

        const byKey = filterLiveEvents([inPlay, { ...inPlay, matchId: '1-2-999-12' }], {
            tour: 'ATP',
            tournamentKey: '20340',
        });
        expect(byKey).toHaveLength(1);
        expect(byKey[0].matchId).toBe('2072-2315-20340-12');
    });
});

describe('matchKey resolution', () => {
    it('prefers Core fixture id and never uses the live event id', () => {
        const core = { id: 555, player1Id: 2072, player2Id: 2315, roundId: 12, seed1: '1' };
        expect(resolveMatchKey(inPlay, core)).toBe('555');
        expect(resolveMatchKey(inPlay, null)).toBe('2072-2315-20340-12');
        expect(resolveMatchKey(inPlay, { id: '3815731' })).toBe('2072-2315-20340-12');
        const mapped = mapLiveEvent(inPlay, core);
        expect(mapped.matchKey).toBe('555');
        expect(mapped.matchKey).not.toBe(inPlay.id);
        expect(mapped.isLive).toBe(true);
        expect(mapped.status).toBe('Live');
        expect(mapped.setScores).toEqual(['6-4', '3-2']);
        expect(mapped.currentGame).toBe('30 - 15');
        expect(mapped.player1Key).toBe('2072');
        expect(mapped.player2Key).toBe('2315');
        expect(mapped.tournamentKey).toBe('20340');
        expect(mapped.roundId).toBe(12);
        expect(mapped.player1Seed).toBe(1);
    });

    it('drops events that cannot be keyed without the live event id', () => {
        expect(mapLiveEvent({ ...inPlay, matchId: null }, null)).toBeNull();
    });
});

describe('mergeLiveOverBoard', () => {
    it('live overlay wins on matchKey or player+round; fixtures stay isLive false alone', () => {
        const board = [{
            matchKey: '555',
            player1Key: '2072',
            player2Key: '2315',
            player1Name: 'J. Sinner',
            player2Name: 'C. Alcaraz',
            isLive: false,
            status: 'Not Started',
            setScores: [],
            currentGame: null,
            roundId: 12,
            tournamentKey: '20340',
        }];
        const live = [mapLiveEvent(inPlay, { id: 555, player1Id: 2072, player2Id: 2315, roundId: 12 })];
        const merged = mergeLiveOverBoard(board, live);
        expect(merged).toHaveLength(1);
        expect(merged[0].matchKey).toBe('555');
        expect(merged[0].isLive).toBe(true);
        expect(merged[0].setScores).toEqual(['6-4', '3-2']);
        expect(merged[0].currentGame).toBe('30 - 15');

        const swapped = [{
            ...board[0],
            matchKey: 'other',
            player1Key: '2315',
            player2Key: '2072',
        }];
        const byPair = mergeLiveOverBoard(swapped, live);
        expect(byPair[0].isLive).toBe(true);
        expect(byPair[0].matchKey).toBe('other');

        const fixturesOnly = mergeLiveOverBoard(board, []);
        expect(fixturesOnly.every(m => m.isLive === false)).toBe(true);
    });

    it('does not let live Upcoming snap a Finished result back to Not Started', () => {
        const board = [{
            matchKey: '167421758',
            player1Key: '45191',
            player2Key: '59913',
            isLive: false,
            status: 'Finished',
            setScores: ['6-4', '6-2'],
            currentGame: null,
            roundId: 7,
            tournamentKey: '16743',
        }];
        const merged = mergeLiveOverBoard(board, [{
            matchKey: '1023',
            player1Key: '45191',
            player2Key: '59913',
            isLive: false,
            status: 'Not Started',
            setScores: [],
            currentGame: null,
            roundId: 7,
            tournamentKey: '16743',
        }]);
        expect(merged[0].status).toBe('Finished');
        expect(merged[0].setScores).toEqual(['6-4', '6-2']);
    });

    it('applyLiveOverlayToHub sets isLive/scores on today + featured and does not add extras', () => {
        const hub = {
            featuredMatch: {
                matchKey: '866',
                player1Name: 'A. Sabalenka',
                isLive: false,
                status: 'Not Started',
                setScores: [],
                currentGame: null,
                roundId: 9,
            },
            todaysMatches: [
                {
                    matchKey: '889',
                    player1Key: '32480',
                    player2Key: '42098',
                    player1Name: 'A. Kalinskaya',
                    player2Name: 'E. Navarro',
                    isLive: false,
                    status: 'Not Started',
                    setScores: [],
                    currentGame: null,
                    roundId: 7,
                    tournamentKey: '16743',
                },
            ],
        };
        const live = [{
            matchKey: '889',
            player1Key: '32480',
            player2Key: '42098',
            isLive: true,
            status: 'Live',
            setScores: ['4-4'],
            currentGame: '0 - 15',
            roundId: 7,
            tournamentKey: '16743',
        }, {
            matchKey: 'other-tour',
            player1Key: '1',
            player2Key: '2',
            isLive: true,
            status: 'Live',
            setScores: ['1-0'],
            currentGame: '15 - 0',
            roundId: 6,
            tournamentKey: '99',
        }];
        const over = applyLiveOverlayToHub(hub, live);
        expect(over.todaysMatches).toHaveLength(1);
        expect(over.todaysMatches[0].isLive).toBe(true);
        expect(over.todaysMatches[0].setScores).toEqual(['4-4']);
        expect(over.todaysMatches[0].currentGame).toBe('0 - 15');
        expect(over.featuredMatch.matchKey).toBe('889');
        expect(over.featuredMatch.isLive).toBe(true);
        expect(applyLiveOverlayToHub(hub, [])).toEqual(hub);
    });

    it('applyLiveOverlayToHub promotes Finished (not isLive-only) onto today + featured', () => {
        const hub = {
            featuredMatch: {
                matchKey: '1023',
                player1Key: '45191',
                player2Key: '59913',
                isLive: false,
                status: 'Not Started',
                setScores: [],
                currentGame: null,
                roundId: 7,
                tournamentKey: '16743',
            },
            todaysMatches: [{
                matchKey: '1023',
                player1Key: '45191',
                player2Key: '59913',
                isLive: false,
                status: 'Not Started',
                setScores: [],
                currentGame: null,
                roundId: 7,
                tournamentKey: '16743',
            }],
        };
        const over = applyLiveOverlayToHub(hub, [{
            matchKey: '167421758',
            player1Key: '59913',
            player2Key: '45191',
            isLive: false,
            status: 'Finished',
            setScores: ['6-4', '6-2'],
            currentGame: null,
            roundId: 7,
            tournamentKey: '16743',
        }]);
        expect(over.todaysMatches).toHaveLength(1);
        expect(over.todaysMatches[0]).toMatchObject({
            matchKey: '1023',
            isLive: false,
            status: 'Finished',
            setScores: ['6-4', '6-2'],
        });
        expect(over.featuredMatch.status).toBe('Finished');
        expect(over.featuredMatch.setScores).toEqual(['6-4', '6-2']);
        expect(over.featuredMatch.isLive).toBe(false);
    });
});

describe('dedupe / sticky completion / delayed', () => {
    it('results win over a stale same-pair fixture (either player order)', () => {
        const board = [{
            matchKey: '1023',
            player1Key: '45191',
            player2Key: '59913',
            isLive: false,
            status: 'Not Started',
            setScores: [],
            roundId: 7,
            tournamentKey: '16743',
        }, {
            matchKey: '167421758',
            player1Key: '59913',
            player2Key: '45191',
            isLive: false,
            status: 'Finished',
            setScores: ['6-4', '6-2'],
            winner: 'player1',
            roundId: 7,
            tournamentKey: '16743',
        }];
        const deduped = dedupeBoardByPair(board);
        expect(deduped).toHaveLength(1);
        expect(deduped[0].matchKey).toBe('167421758');
        expect(deduped[0].status).toBe('Finished');
        expect(deduped[0].setScores).toEqual(['6-4', '6-2']);
        expect(rowPairKey(board[0])).toBe(rowPairKey(board[1]));
    });

    it('sticky marks Finished with last scores after InPlay disappears; true NS stays NS', () => {
        const fixture = {
            matchKey: '555',
            player1Key: '2072',
            player2Key: '2315',
            player1Name: 'J. Sinner',
            player2Name: 'C. Alcaraz',
            isLive: false,
            status: 'Not Started',
            setScores: [],
            currentGame: null,
            roundId: 12,
            tournamentKey: '20340',
        };
        const seen = snapshotSeenLive([{
            ...fixture,
            isLive: true,
            status: 'Live',
            setScores: ['6-4', '3-2'],
            currentGame: '30 - 15',
        }]);
        const sticky = applyStickyCompletions([fixture], seen, []);
        expect(sticky).toHaveLength(1);
        expect(sticky[0]).toMatchObject({
            matchKey: '555',
            isLive: false,
            status: 'Finished',
            setScores: ['6-4', '3-2'],
            currentGame: '30 - 15',
        });

        const stillNs = applyStickyCompletions([fixture], [], []);
        expect(stillNs[0].status).toBe('Not Started');
        expect(stillNs[0].setScores).toEqual([]);

        const stillLive = applyStickyCompletions([fixture], seen, [{
            matchKey: '555',
            player1Key: '2072',
            player2Key: '2315',
            isLive: true,
            status: 'Live',
            setScores: ['6-4', '5-4'],
            roundId: 12,
            tournamentKey: '20340',
        }]);
        expect(stillLive[0].status).toBe('Not Started');
    });

    it('does not invent scores when marking a past-start fixture Delayed', () => {
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        expect(isPastScheduledStart(today)).toBe(false);
        expect(isPastScheduledStart(yesterday)).toBe(true);
        expect(isPastScheduledStart('2020-01-01T12:00:00.000Z', new Date('2020-01-01T18:00:00.000Z'))).toBe(true);

        const marked = markPastStartUnplayed([{
            matchKey: '933',
            status: 'Not Started',
            isLive: false,
            setScores: [],
            date: '2020-01-01T12:00:00.000Z',
        }], new Date('2020-01-01T18:00:00.000Z'));
        expect(marked[0].status).toBe('Delayed');
        expect(marked[0].setScores).toEqual([]);
        expect(marked[0].isLive).toBe(false);

        const live = markPastStartUnplayed([{
            matchKey: '1',
            status: 'Live',
            isLive: true,
            setScores: ['1-0'],
            date: '2020-01-01T12:00:00.000Z',
        }], new Date('2020-01-01T18:00:00.000Z'));
        expect(live[0].status).toBe('Live');
    });

    it('completedSetChanged is false for the same sticky set (no extra KV write)', () => {
        const row = { matchKey: '555', player1Key: '1', player2Key: '2', roundId: 12, tournamentKey: '9', stickyComplete: true };
        expect(completedSetChanged([row], [{ ...row }])).toBe(false);
        expect(completedSetChanged([], [row])).toBe(true);
        expect(completedSetChanged([row], [])).toBe(true);
    });
});

describe('indexCoreMatches / unwrapLiveEvents', () => {
    it('lets results overwrite fixtures and unwraps RapidAPI list envelopes', () => {
        const fixtures = new Map([['20340', [{ id: 1, player1Id: 2072, player2Id: 2315, roundId: 12 }]]]);
        const results  = new Map([['20340', [{ id: 9, player1Id: 2072, player2Id: 2315, roundId: 12 }]]]);
        const idx = indexCoreMatches(fixtures, results);
        expect(idx.get('2072|2315|12|20340').id).toBe(9);

        expect(unwrapLiveEvents({ result: [inPlay] })).toEqual([inPlay]);
        expect(unwrapLiveEvents({ data: { events: [inPlay] } })).toEqual([inPlay]);
        expect(unwrapLiveEvents(null)).toEqual([]);
    });

    it('unwraps MatchStat { results } envelope and maps InPlay to isLive rows', () => {
        const payload = { success: true, results: [inPlay], count: 1 };
        const events = unwrapLiveEvents(payload);
        expect(events).toEqual([inPlay]);
        expect(unwrapLiveEvents({ results: [inPlay] })).toEqual([inPlay]);

        const mapped = mapLiveEvent(events[0], { id: 555, player1Id: 2072, player2Id: 2315, roundId: 12 });
        expect(mapped).not.toBeNull();
        expect(mapped.isLive).toBe(true);
        expect(mapped.status).toBe('Live');
        expect(mapped.setScores).toEqual(['6-4', '3-2']);
        expect(mapped.currentGame).toBe('30 - 15');
        expect(mapped.matchKey).toBe('555');
    });
});
