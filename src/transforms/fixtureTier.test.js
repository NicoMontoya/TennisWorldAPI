import { describe, expect, it } from 'vitest';
import { fixtureTier, orderFixturesByTier, selectTourTarget } from './fixtureTier.js';
import { normalizeFixturesFeed } from './fixturesFeed.js';

describe('fixture tier mapping', () => {
    it('maps tour levels from rank id or from the event name', () => {
        const tour = [
            { rankId: 2 },
            { rankId: 3 },
            { rankId: 4 },
            { rankId: 5 },
            { rankId: 7 },
            { tournamentName: 'Nitto ATP Finals' },
            { tournamentName: 'Roland Garros' },
            { tournamentName: 'Australian Open' },
            { tournamentName: 'Wimbledon' },
            { tournamentName: 'US Open' },
            { rankName: 'Grand Slam' },
            { rankName: 'ATP Masters 1000' },
            { rankName: 'WTA 1000' },
            { tournamentName: 'Vienna', rankName: 'ATP 500' },
            { tournamentName: 'Metz', rankName: 'ATP 250' },
            { tournamentName: 'United Cup' },
            { tournamentName: 'Davis Cup Finals' },
            { tournamentName: 'Billie Jean King Cup' },
            { rankName: 'BJK' },
            { rankName: 'Main tour' },
        ];
        for (const row of tour) expect(fixtureTier(row), JSON.stringify(row)).toBe('tour');
    });

    it('maps challengers and ITF, and does not let a generic ATP label outrank them', () => {
        expect(fixtureTier({ tournamentName: 'Lyon', rankName: 'Challenger 175' })).toBe('challenger');
        expect(fixtureTier({ rankId: 1, tournamentName: 'Nitto ATP Finals' })).toBe('challenger');
        expect(fixtureTier({ tournamentName: 'WTA 125 Angers' })).toBe('challenger');
        expect(fixtureTier({ eventType: 'ATP Challenger Singles' })).toBe('challenger');

        expect(fixtureTier({ tournamentName: 'Monastir', rankName: 'ITF' })).toBe('itf');
        expect(fixtureTier({ tournamentName: 'M25 Austin' })).toBe('itf');
        expect(fixtureTier({ tournamentName: 'W35 Nantes' })).toBe('itf');
        expect(fixtureTier({ rankName: 'Futures' })).toBe('itf');
        expect(fixtureTier({ rankId: 0, tournamentName: 'Nitto ATP Finals' })).toBe('itf');

        expect(fixtureTier({ tournamentName: 'Metz', eventType: 'ATP Singles' })).toBe('itf');
        expect(fixtureTier({ eventType: 'WTA Doubles' })).toBe('itf');
        expect(fixtureTier({})).toBe('itf');
    });

    it('orders tour, then challenger, then itf, and keeps startsAtUtc', () => {
        const ordered = orderFixturesByTier([
            { matchKey: 'c', tournamentName: 'Challenger Lyon', startsAtUtc: '2026-11-16T12:00:00.000Z' },
            { matchKey: 'i', tournamentName: 'ITF Monastir', startsAtUtc: '2026-11-16T13:00:00.000Z' },
            { matchKey: 't', tournamentName: 'Nitto ATP Finals', startsAtUtc: '2026-11-16T14:00:00.000Z' },
        ]);
        expect(ordered.map(row => row.matchKey)).toEqual(['t', 'c', 'i']);
        expect(ordered.map(row => row.tier)).toEqual(['tour', 'challenger', 'itf']);
        expect(ordered[0].startsAtUtc).toBe('2026-11-16T14:00:00.000Z');
    });

    it('stamps tier from the tournament object without using the synthetic event type', () => {
        const [row] = normalizeFixturesFeed({
            data: [{
                id: 11,
                date: '2026-11-16T18:00:00.000Z',
                roundId: 8,
                tournament: { id: 501, name: 'Nitto ATP Finals', rankId: 7 },
                player1: { id: 1, name: 'A' },
                player2: { id: 2, name: 'B' },
            }],
        }, { tour: 'ATP' });
        expect(row).toMatchObject({
            matchKey: '11',
            tournamentName: 'Nitto ATP Finals',
            eventType: 'ATP Singles',
            tier: 'tour',
            startsAtUtc: '2026-11-16T18:00:00.000Z',
        });
    });
});

describe('selectTourTarget', () => {
    const now = new Date('2026-11-15T18:00:00.000Z');

    it('picks the current Finals ahead of another live tour event and ignores the rest', () => {
        const target = selectTourTarget([
            { id: 42, name: 'Test Open', tier: 'ATP 250', date: '2026-11-15T00:00:00.000Z' },
            { id: 77, name: 'Lyon Challenger', tier: 'Challenger', date: '2026-11-15T00:00:00.000Z' },
            { id: 9, name: 'Australian Open', tier: 'Grand Slam', date: '2026-01-18T00:00:00.000Z' },
            { id: 'nope', name: 'Nitto ATP Finals', tier: 'Finals', date: '2026-11-15T00:00:00.000Z' },
            { id: 501, name: 'Nitto ATP Finals', tier: 'Finals', date: '2026-11-15T00:00:00.000Z' },
            { id: 88, name: 'Davis Cup Finals', tier: 'Davis Cup', date: '2026-11-15T00:00:00.000Z' },
        ], now);
        expect(target).toEqual({ id: '501', name: 'Nitto ATP Finals', tier: 'Finals' });
    });

    it('returns null when nothing stored is a current tour event', () => {
        expect(selectTourTarget([
            { id: 77, name: 'Lyon Challenger', tier: 'Challenger', date: '2026-11-15T00:00:00.000Z' },
        ], now)).toBeNull();
    });

    it('skips events the calendar marks finished or completed', () => {
        const live = { id: 501, name: 'Nitto ATP Finals', tier: 'Finals', date: '2026-11-15T00:00:00.000Z' };
        expect(selectTourTarget([
            { ...live, id: 42, name: 'Paris', tier: 'ATP Masters 1000', finished: 1 },
        ], now)).toBeNull();
        expect(selectTourTarget([
            { ...live, id: 43, name: 'Paris', tier: 'ATP Masters 1000', status: 'completed' },
        ], now)).toBeNull();
        expect(selectTourTarget([
            { ...live, id: 44, name: 'Stockholm', tier: 'ATP 250', status: 'finished' },
        ], now)).toBeNull();
        expect(selectTourTarget([
            { id: 44, name: 'Stockholm', tier: 'ATP 250', date: '2026-11-09T00:00:00.000Z', status: 'live', finished: 0 },
            { id: 42, name: 'Paris', tier: 'ATP Masters 1000', date: '2026-11-14T00:00:00.000Z', status: 'completed' },
        ], now)).toEqual({ id: '44', name: 'Stockholm', tier: 'ATP 250' });
    });

    it('uses an 8-day lookback for non-Slams and 14 days for Slams', () => {
        expect(selectTourTarget([
            { id: 42, name: 'Paris', tier: 'ATP Masters 1000', date: '2026-11-02T00:00:00.000Z' },
        ], now)).toBeNull();
        expect(selectTourTarget([
            { id: 43, name: 'Stockholm', tier: 'ATP 250', date: '2026-11-06T00:00:00.000Z' },
        ], now)).toBeNull();
        expect(selectTourTarget([
            { id: 44, name: 'Stockholm', tier: 'ATP 250', date: '2026-11-07T00:00:00.000Z' },
        ], now)).toEqual({ id: '44', name: 'Stockholm', tier: 'ATP 250' });
        expect(selectTourTarget([
            { id: 9, name: 'US Open', tier: 'Grand Slam', rankId: 4, date: '2026-11-03T00:00:00.000Z' },
        ], now)).toEqual({ id: '9', name: 'US Open', tier: 'Grand Slam' });
        expect(selectTourTarget([
            { id: 9, name: 'US Open', tier: 'Grand Slam', rankId: 4, date: '2026-10-31T00:00:00.000Z' },
        ], now)).toBeNull();
    });
});
