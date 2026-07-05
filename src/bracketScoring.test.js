import { describe, it, expect } from 'vitest';
import { computeBracketScore } from './bracketScoring.js';

// 4-player draw: first delivered round = QF-ish (roundId 10, col 0, weight 1),
// Final (roundId 12, col 1, weight 2).
function draw({ sfDecided = false, finalDelivered = false, finalDecided = false } = {}) {
    const rounds = [{
        round: 'Semifinals',
        matches: [
            { matchKey: '10', roundId: 10, player1Key: 'A', player2Key: 'B',
              winner: sfDecided ? 'player1' : null, status: sfDecided ? 'Finished' : 'Not Started' },
            { matchKey: '11', roundId: 10, player1Key: 'C', player2Key: 'D',
              winner: sfDecided ? 'player2' : null, status: sfDecided ? 'Finished' : 'Not Started' },
        ],
    }];
    if (finalDelivered) {
        rounds.push({
            round: 'Final',
            matches: [
                { matchKey: '100', roundId: 12, player1Key: 'A', player2Key: 'D',
                  winner: finalDecided ? 'player1' : null, status: finalDecided ? 'Finished' : 'Not Started' },
            ],
        });
    }
    return rounds;
}

describe('computeBracketScore', () => {
    it('scores a correct decided pick with the round weight (col 0 → 1pt)', () => {
        const r = computeBracketScore(draw({ sfDecided: true }), { '10': 'A', '11': 'C' });
        // A correct (1pt); C lost to D → incorrect.
        expect(r.score).toBe(1);
        expect(r.correct).toBe(1);
        expect(r.decided).toBe(2);
        expect(r.accuracy).toBe(50);
    });

    it('weights the final at 2^1 on a 4-player draw', () => {
        const r = computeBracketScore(
            draw({ sfDecided: true, finalDelivered: true, finalDecided: true }),
            { '10': 'A', '100': 'A' },
        );
        expect(r.score).toBe(1 + 2);
    });

    it('scores a positional __inf pick after the round materializes', () => {
        // Pick was saved pre-final: '__inf_1_0' = A. Final now delivered + decided.
        const r = computeBracketScore(
            draw({ sfDecided: true, finalDelivered: true, finalDecided: true }),
            { '10': 'A', '__inf_1_0': 'A' },
        );
        expect(r.score).toBe(3);
        expect(r.correct).toBe(2);
    });

    it('maxPossible drops weights whose picked player was eliminated', () => {
        // SFs decided: A won, C lost (eliminated). Final undelivered.
        // Picks: final winner = C (eliminated) → no potential from the final.
        const rEliminated = computeBracketScore(draw({ sfDecided: true }), { '__inf_1_0': 'C' });
        expect(rEliminated.maxPossible).toBe(0);
        // Picks: final winner = A (alive) → potential 2.
        const rAlive = computeBracketScore(draw({ sfDecided: true }), { '__inf_1_0': 'A' });
        expect(rAlive.maxPossible).toBe(2);
    });

    it('accuracy is null before anything is decided; empty inputs are safe', () => {
        const r = computeBracketScore(draw(), { '10': 'A' });
        expect(r.accuracy).toBeNull();
        expect(r.maxPossible).toBe(1);
        expect(computeBracketScore([], {}).score).toBe(0);
        expect(computeBracketScore(null, null).totalPicks).toBe(0);
    });
});

import { positionalKeyMap } from './bracketScoring.js';

describe('positionalKeyMap (decided-slot lock support)', () => {
    it('maps positional keys to real matchKeys for delivered rounds', () => {
        const rounds = draw({ sfDecided: true, finalDelivered: true });
        const map = positionalKeyMap(rounds);
        expect(map.get('__inf_0_0')).toBe('10');
        expect(map.get('__inf_0_1')).toBe('11');
        expect(map.get('__inf_1_0')).toBe('100');
    });
});

describe('retro picks (hindsight never scores)', () => {
    it('excludes retro-flagged picks from score and maxPossible', () => {
        const rounds = draw({ sfDecided: true, finalDelivered: true, finalDecided: true });
        // Both picks match actual winners, but '10' was made with hindsight.
        const r = computeBracketScore(rounds, { '10': 'A', '100': 'A' }, { '10': true });
        expect(r.score).toBe(2);        // only the final (weight 2) counts
        expect(r.totalPicks).toBe(2);   // still displayed as a pick
        expect(r.decided).toBe(1);      // retro excluded from accuracy base
    });
});

describe('slotIndex authority', () => {
    it('positional keys follow slotIndex, not matchKey order', () => {
        // matchKey order says 10 < 11, but the official bracket order (slotIndex)
        // puts match 11 first — positional keys must follow slotIndex.
        const rounds = [{
            round: 'SF',
            matches: [
                { matchKey: '10', roundId: 10, slotIndex: 1, player1Key: 'A', player2Key: 'B', winner: null },
                { matchKey: '11', roundId: 10, slotIndex: 0, player1Key: 'C', player2Key: 'D', winner: null },
            ],
        }];
        const map = positionalKeyMap(rounds);
        expect(map.get('__inf_0_0')).toBe('11');
        expect(map.get('__inf_0_1')).toBe('10');
    });
});
