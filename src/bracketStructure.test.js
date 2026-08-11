import { describe, it, expect } from 'vitest';
import { trueLeaves, relabelByDepth } from './bracketStructure.js';

// Build a rounds array from a list of [matchCount, upstreamRoundId, order] tuples.
// order/upstreamRoundId are the (unreliable) values the current route produces.
function mkRounds(specs) {
    return specs.map(([count, rid, order]) => ({
        round: `raw-${rid}`,
        order,
        matches: Array.from({ length: count }, (_, i) => ({
            matchKey: String(rid * 1000 + i), roundId: rid,
        })),
    }));
}
function labels(rounds) {
    return rounds.slice().sort((a, b) => b.order - a.order).map(r => r.round);
}

describe('trueLeaves — recover draw size from the bye signature', () => {
    it('no-bye draws: leaves = players', () => {
        expect(trueLeaves([64, 32, 16, 8, 4, 2, 1])).toBe(128); // Grand Slam
        expect(trueLeaves([16, 8, 4, 2, 1])).toBe(32);          // ATP 500
        expect(trueLeaves([32, 16, 8, 4, 2, 1])).toBe(64);      // 64-draw
    });
    it('96-draw (Masters 1000, top-32 byes): R1=32, R2=32 → 128 leaves', () => {
        // 32 play-in matches, then 32 seeds join → 32 R2 matches. byes = 2·32−32 = 32.
        expect(trueLeaves([32, 32, 16, 8, 4, 2, 1])).toBe(128);
    });
    it('48-draw (top-16 byes): R1=16, R2=16 → 64 leaves', () => {
        expect(trueLeaves([16, 16, 8, 4, 2, 1])).toBe(64);
    });
    it('lone first round falls back to no-bye assumption', () => {
        expect(trueLeaves([16])).toBe(32);
        expect(trueLeaves([64])).toBe(128);
    });
    it('override hint wins', () => {
        expect(trueLeaves([32], 96)).toBe(128);
        expect(trueLeaves([12], 28)).toBe(32);
    });
});

describe('relabelByDepth — depth-from-final labels, not upstream roundId', () => {
    it('96-draw: shifts every round down one level, R32 no longer holds 31', () => {
        // The bug reproduction: upstream roundIds 5,6,7,9,10 → old map mislabels.
        const rounds = mkRounds([[32, 5, 6], [32, 6, 5], [16, 7, 4], [8, 9, 3], [4, 10, 2]]);
        relabelByDepth(rounds);
        expect(labels(rounds)).toEqual(
            ['Round of 128', 'Round of 64', 'Round of 32', 'Round of 16', 'Quarter-finals']);
        // The round with 16 matches is now "Round of 32" (16 ≤ 32) — invariant holds.
        const r32 = rounds.find(r => r.round === 'Round of 32');
        expect(r32.matches.length).toBe(16);
        // roundIds re-stamped to canonical depth ids.
        expect(rounds.find(r => r.round === 'Round of 128').matches[0].roundId).toBe(4);
    });
    it('32-draw: first round is "Round of 32", not "Round of 128"', () => {
        const rounds = mkRounds([[16, 4, 7], [8, 5, 6], [4, 6, 5], [2, 7, 4], [1, 9, 3]]);
        relabelByDepth(rounds);
        expect(labels(rounds)).toEqual(
            ['Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Final']);
    });
    it('128-draw: idempotent (already canonical)', () => {
        const rounds = mkRounds([[64, 4, 7], [32, 5, 6], [16, 6, 5], [8, 7, 4], [4, 9, 3], [2, 10, 2], [1, 12, 1]]);
        relabelByDepth(rounds);
        expect(labels(rounds)).toEqual(
            ['Round of 128', 'Round of 64', 'Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Final']);
    });
    it('partial mid-tournament draw (final not played) still labels correctly', () => {
        // 96-draw captured only through the quarter-finals.
        const rounds = mkRounds([[32, 5, 6], [32, 6, 5], [16, 7, 4], [8, 9, 3]]);
        relabelByDepth(rounds);
        expect(labels(rounds)).toEqual(
            ['Round of 128', 'Round of 64', 'Round of 32', 'Round of 16']);
    });
    it('leaves round-robin structures untouched', () => {
        const rounds = mkRounds([[6, 8, 1.5]]);
        relabelByDepth(rounds);
        expect(rounds[0].round).toBe('raw-8');
    });
    it('every relabeled draw satisfies the "Round of N holds ≤ N/2" invariant', () => {
        for (const spec of [
            [[64, 4, 7], [32, 5, 6], [16, 6, 5], [8, 7, 4], [4, 9, 3], [2, 10, 2], [1, 12, 1]],
            [[32, 5, 6], [32, 6, 5], [16, 7, 4], [8, 9, 3], [4, 10, 2]],
            [[16, 4, 7], [8, 5, 6], [4, 6, 5], [2, 7, 4], [1, 9, 3]],
        ]) {
            const rounds = mkRounds(spec);
            relabelByDepth(rounds);
            for (const r of rounds) {
                const mm = /round of (\d+)/i.exec(r.round);
                if (mm) expect(r.matches.length).toBeLessThanOrEqual(parseInt(mm[1], 10) / 2);
            }
            // counts never increase earliest→latest
            const desc = rounds.slice().sort((a, b) => b.order - a.order).map(r => r.matches.length);
            for (let i = 1; i < desc.length; i++) expect(desc[i]).toBeLessThanOrEqual(desc[i - 1]);
        }
    });
});

import { expandByes } from './bracketStructure.js';

describe('expandByes — reconstruct the play-in round + byes for a bye draw', () => {
    // A tiny "96-style" draw: 12 entrants in a 16-leaf tree = 4 byes.
    //   R16 (play-in): 4 real matches (8 non-seeds) → roundId 4
    //   R8  (2nd round): 8 players (4 play-in winners + 4 seeds) → roundId 5
    // Use single-letter keys. Play-in winners: A,C,E,G. Seeds (byes): S1,S2,S3,S4.
    function byeDraw() {
        return [
            { round: 'Round of 8', order: 6, matches: [ // second round (roundId 5)
                { matchKey: '50', roundId: 5, player1Key: 'S1', player1Name: 'Seed1', player1Seed: 1, player2Key: 'A', player2Name: 'A', winner: null },
                { matchKey: '51', roundId: 5, player1Key: 'C', player1Name: 'C', player2Key: 'S2', player2Name: 'Seed2', player2Seed: 2, winner: null },
                { matchKey: '52', roundId: 5, player1Key: 'S3', player1Name: 'Seed3', player1Seed: 3, player2Key: 'E', player2Name: 'E', winner: null },
                { matchKey: '53', roundId: 5, player1Key: 'G', player1Name: 'G', player2Key: 'S4', player2Name: 'Seed4', player2Seed: 4, winner: null },
            ]},
            { round: 'Round of 16', order: 7, matches: [ // play-in (roundId 4): 4 real matches
                { matchKey: '40', roundId: 4, player1Key: 'A', player1Name: 'A', player2Key: 'B', player2Name: 'B', winner: 'player1' },
                { matchKey: '41', roundId: 4, player1Key: 'C', player1Name: 'C', player2Key: 'D', player2Name: 'D', winner: 'player1' },
                { matchKey: '42', roundId: 4, player1Key: 'E', player1Name: 'E', player2Key: 'F', player2Name: 'F', winner: 'player1' },
                { matchKey: '43', roundId: 4, player1Key: 'G', player1Name: 'G', player2Key: 'H', player2Name: 'H', winner: 'player1' },
            ]},
        ];
    }

    it('expands the play-in round to full width (leaves/2) with byes threaded from round 2', () => {
        const rounds = byeDraw();
        expandByes(rounds, 16); // 16-leaf tree → play-in should be 8 slots
        const playIn = rounds.find(r => r.order === 7);
        expect(playIn.matches.length).toBe(8);
        // Slots 2j/2j+1 feed second-round slot j: slot 0 = feeder of R8[0].player1 (S1, a bye),
        // slot 1 = feeder of R8[0].player2 (A, won play-in '40').
        expect(playIn.matches[0].isBye).toBe(true);
        expect(playIn.matches[0].player1Key).toBe('S1');
        expect(playIn.matches[0].winner).toBe('player1'); // seed auto-advances
        expect(playIn.matches[1].matchKey).toBe('40');     // A's real play-in match
    });

    it('bye matches carry player2 = BYE and a Finished status so the seed advances', () => {
        const rounds = byeDraw();
        expandByes(rounds, 16);
        const playIn = rounds.find(r => r.order === 7);
        const byes = playIn.matches.filter(m => m.isBye);
        expect(byes.length).toBe(4); // 4 seeds
        for (const b of byes) {
            expect(b.player2Name).toBe('BYE');
            expect(b.status).toBe('Finished');
            expect(b.winner).toBe('player1');
        }
    });

    it('is a no-op for a full (no-bye) draw', () => {
        const rounds = [
            { round: 'Round of 16', order: 4, matches: Array.from({length:8},(_,i)=>({matchKey:`m${i}`,roundId:7,player1Key:`p${i}a`,player2Key:`p${i}b`,winner:null})) },
            { round: 'Round of 32', order: 5, matches: Array.from({length:16},(_,i)=>({matchKey:`n${i}`,roundId:6,player1Key:`q${i}a`,player2Key:`q${i}b`,winner:null})) },
        ];
        const before = rounds[1].matches.length;
        expandByes(rounds, 32);
        expect(rounds.find(r=>r.order===5).matches.length).toBe(before); // unchanged
    });
});
