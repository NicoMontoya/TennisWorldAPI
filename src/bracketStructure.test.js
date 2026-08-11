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
