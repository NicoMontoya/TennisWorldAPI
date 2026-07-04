import { describe, it, expect } from 'vitest';
import {
    transformStandings,
    transformFixtures,
    transformPlayer,
    transformH2H,
} from './index.js';

// ── transformStandings ─────────────────────────────────────────────────────────
describe('transformStandings', () => {
    it('maps raw fields correctly', () => {
        const raw = [{
            place: '1', player: 'J. Sinner', player_key: '2072',
            league: 'ATP', movement: 'up', country: 'Italy', points: '9860',
        }];
        const [r] = transformStandings(raw);
        expect(r.rank).toBe(1);
        expect(r.name).toBe('J. Sinner');
        expect(r.movement).toBe(1);
        expect(r.points).toBe(9860);
        expect(r.tour).toBe('ATP');
    });

    it('handles movement down and neutral', () => {
        const raw = [
            { place: '2', player: 'A', player_key: '1', league: 'ATP', movement: 'down', country: 'X', points: '1000' },
            { place: '3', player: 'B', player_key: '2', league: 'ATP', movement: '',     country: 'Y', points: '900'  },
        ];
        const [down, neutral] = transformStandings(raw);
        expect(down.movement).toBe(-1);
        expect(neutral.movement).toBe(0);
    });

    it('returns empty array for non-array input', () => {
        expect(transformStandings(null)).toEqual([]);
        expect(transformStandings(undefined)).toEqual([]);
        expect(transformStandings('string')).toEqual([]);
    });
});

// ── transformFixtures ──────────────────────────────────────────────────────────
describe('transformFixtures', () => {
    const baseRaw = {
        event_key: '12345', tournament_key: '2004',
        tournament_name: ' Madrid ', event_date: '2026-05-03',
        event_time: '17:10', event_status: 'Finished',
        tournament_round: 'ATP Madrid - Final',
        event_first_player: 'J. Sinner', first_player_key: '2072',
        event_second_player: 'A. Zverev', second_player_key: '1980',
        event_final_result: '2 - 0', event_winner: 'First Player',
        event_live: '0', event_type_type: 'Atp Singles',
        tournament_season: '2026', pointbypoint: [],
    };

    it('trims tournament name', () => {
        const [r] = transformFixtures([baseRaw]);
        expect(r.tournamentName).toBe('Madrid');
    });

    it('sets isLive correctly', () => {
        const live = { ...baseRaw, event_live: '1', event_status: '1' };
        const [r] = transformFixtures([live]);
        expect(r.isLive).toBe(true);
    });

    it('returns empty array for non-array input', () => {
        expect(transformFixtures(null)).toEqual([]);
    });

    it('parses setScores from pointbypoint', () => {
        const pbp = [
            { set_number: 'Set 1', number_game: '1', serve_winner: 'First Player', serve_lost: null, score: '1 - 0', points: [] },
            { set_number: 'Set 1', number_game: '6', serve_winner: 'First Player', serve_lost: null, score: '6 - 1', points: [] },
            { set_number: 'Set 2', number_game: '1', serve_winner: 'Second Player', serve_lost: null, score: '0 - 1', points: [] },
            { set_number: 'Set 2', number_game: '8', serve_winner: 'First Player', serve_lost: null, score: '6 - 2', points: [] },
        ];
        const [r] = transformFixtures([{ ...baseRaw, pointbypoint: pbp }]);
        expect(r.setScores).toHaveLength(2);
        expect(r.setScores[0]).toMatchObject({ set: 'Set 1', p1: 6, p2: 1, tiebreak: null });
        expect(r.setScores[1]).toMatchObject({ set: 'Set 2', p1: 6, p2: 2, tiebreak: null });
    });

    it('parses tiebreak scores', () => {
        const pbp = [
            { set_number: 'Set 1', serve_winner: 'First Player', serve_lost: null, score: '7 - 6', points: [] },
            { set_number: 'Set 1 TieBreak', serve_winner: 'First Player', serve_lost: null, score: '7 - 4', points: [] },
        ];
        const [r] = transformFixtures([{ ...baseRaw, pointbypoint: pbp }]);
        expect(r.setScores[0]).toMatchObject({ p1: 7, p2: 6, tiebreak: { p1: 7, p2: 4 } });
    });

    it('returns currentGame for in-progress game', () => {
        const pbp = [
            { set_number: 'Set 1', serve_winner: 'First Player', serve_lost: null, score: '3 - 2',
              points: [{ score: '0 - 15' }, { score: '15 - 15' }, { score: '30 - 15' }] },
            // last game has no winner yet
            { set_number: 'Set 1', serve_winner: null, serve_lost: null, score: '3 - 3',
              points: [{ score: '0 - 0' }, { score: '15 - 0' }] },
        ];
        const [r] = transformFixtures([{ ...baseRaw, pointbypoint: pbp }]);
        expect(r.currentGame).toBe('15 - 0');
    });

    it('returns null currentGame when last game is finished', () => {
        const pbp = [
            { set_number: 'Set 1', serve_winner: 'First Player', serve_lost: null, score: '1 - 0',
              points: [{ score: '40 - 15' }] },
        ];
        const [r] = transformFixtures([{ ...baseRaw, pointbypoint: pbp }]);
        expect(r.currentGame).toBeNull();
    });

    it('handles retired / walkover (no pointbypoint)', () => {
        const retired = { ...baseRaw, event_status: 'Finished', event_final_result: '1 - 0', pointbypoint: [] };
        const [r] = transformFixtures([retired]);
        expect(r.setScores).toEqual([]);
        expect(r.currentGame).toBeNull();
    });
});

// ── transformPlayer ────────────────────────────────────────────────────────────
describe('transformPlayer', () => {
    it('returns null for empty input', () => {
        expect(transformPlayer([])).toBeNull();
        expect(transformPlayer(null)).toBeNull();
    });

    it('maps player fields', () => {
        const raw = [{
            player_key: '2072',
            player_name: 'Sinner',
            player_full_name: 'Jannik Sinner',
            player_country: 'Italy',
            player_bday: '2001-08-16',
            player_logo: 'https://example.com/logo.jpg',
            stats: [
                {
                    season: '2024', type: 'singles', rank: '1', titles: '4',
                    matches_won: '67', matches_lost: '9',
                    hard_won: '50', hard_lost: '7',
                    clay_won: '10', clay_lost: '1',
                    grass_won: '7', grass_lost: '1',
                },
            ],
        }];
        const p = transformPlayer(raw);
        expect(p.name).toBe('Jannik Sinner');
        expect(p.country).toBe('Italy');
        expect(p.seasons).toHaveLength(1);
        expect(p.seasons[0]).toMatchObject({ year: '2024', rank: 1, titles: 4, wins: 67, losses: 9 });
    });
});

// ── transformH2H ───────────────────────────────────────────────────────────────
describe('transformH2H', () => {
    it('returns null for null input', () => {
        expect(transformH2H(null)).toBeNull();
    });

    it('transforms all three arrays', () => {
        const raw = { H2H: [], firstPlayer: [], secondPlayer: [] };
        const r = transformH2H(raw);
        expect(r).toHaveProperty('h2hMatches');
        expect(r).toHaveProperty('player1Recent');
        expect(r).toHaveProperty('player2Recent');
    });
});
