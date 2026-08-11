// ===================================
// TennisWorld — Bracket structure (pure, first-principles)
// ===================================
// A single-elimination bracket is a fully determined binary tree once you know
// the draw size. The upstream feed tags each match with a `roundId` that is
// RELIABLE FOR SEGMENTATION (matches of the same round share a roundId) but
// UNRELIABLE FOR LABELING — it assumes a 128-draw, so a 96-draw's rounds come
// out shifted one level ("Round of 32" holding 31 matches) and a 32-draw's first
// round inherits "Round of 128".
//
// The fix: derive every round's DEPTH-FROM-FINAL from the true leaf count of the
// bracket, not from the upstream roundId. The true leaf count is recovered from
// the bye signature — in a draw with byes, round 2 holds more players than round
// 1 produced, and the surplus is exactly the byes:
//     byes     = max(0, 2·R2count − R1count)
//     entrants = 2·R1count + byes
//     leaves   = nextPow2(entrants)
// Then the earliest captured round sits at depth log2(leaves) − 1, and each
// later round is one shallower, down to the Final at depth 0.
//
// This is substrate-independent: correct for 4/8/16/28/32/48/56/64/96/128 draws,
// with or without byes, whether or not the Final has been played yet.

// Depth-from-final → canonical round descriptor. Index = depth (0 = Final).
// roundId/order mirror the UI renderer's RID_TO_IDX + the pick/scoring modules,
// so a single slot/round authority flows through every consumer.
const DEPTH = [
    { name: 'Final',          rid: 12, order: 1 },
    { name: 'Semi-finals',    rid: 10, order: 2 },
    { name: 'Quarter-finals', rid: 9,  order: 3 },
    { name: 'Round of 16',    rid: 7,  order: 4 },
    { name: 'Round of 32',    rid: 6,  order: 5 },
    { name: 'Round of 64',    rid: 5,  order: 6 },
    { name: 'Round of 128',   rid: 4,  order: 7 },
];
const MAX_DEPTH = DEPTH.length - 1; // 6

function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
}

/**
 * trueLeaves(orderedCounts) — leaf count of the full bracket tree.
 * orderedCounts: match counts per round, EARLIEST round first.
 * Uses the bye signature (R1, R2) when available; falls back to the no-bye
 * assumption (nextPow2 of the first round's players) for a lone first round.
 * `drawSizeHint` (from an official override) wins when provided and sane.
 */
export function trueLeaves(orderedCounts, drawSizeHint) {
    if (drawSizeHint && Number.isFinite(drawSizeHint) && drawSizeHint >= 2) {
        return nextPow2(drawSizeHint);
    }
    const r1 = orderedCounts[0] || 0;
    if (!r1) return 0;
    const r2 = orderedCounts[1];
    if (r2 == null) return nextPow2(2 * r1);           // only first round captured
    const byes = Math.max(0, 2 * r2 - r1);
    const entrants = 2 * r1 + byes;
    return nextPow2(entrants);
}

/**
 * relabelByDepth(rounds) — mutate each round's {round, order} and each match's
 * {round, roundId} so labels/ids reflect true bracket depth. rounds is the
 * array of { round, order, matches:[{roundId,…}] } the draws route builds.
 *
 * Rounds are re-ordered earliest→latest by match count (with the incoming
 * `order` as a stable tiebreak), the leaf count is recovered, and each round is
 * stamped from the DEPTH table. Round-robin / play-off groups (order 1.5) are
 * left untouched. Idempotent for clean 128-draws. Returns the leaf count used.
 */
export function relabelByDepth(rounds, drawSizeHint) {
    if (!rounds || !rounds.length) return 0;
    if (rounds.some(r => r.order === 1.5)) return 0;   // RR / bronze — not a clean tree

    // Earliest round first: more matches = earlier. Stable tiebreak on the
    // incoming order (higher order = earlier) so equal-count bye rounds keep
    // their captured sequence (96-draw play-in before Round of 64).
    const ordered = rounds.slice().sort((a, b) =>
        b.matches.length - a.matches.length || b.order - a.order);

    const counts = ordered.map(r => r.matches.length);
    const leaves = trueLeaves(counts, drawSizeHint);
    if (leaves < 2) return 0;

    const earliestDepth = Math.min(MAX_DEPTH, Math.round(Math.log2(leaves)) - 1);

    ordered.forEach((r, i) => {
        const depth = earliestDepth - i;
        const canon = DEPTH[depth];
        if (!canon) return;                            // deeper than R128 — leave as-is
        r.round = canon.name;
        r.order = canon.order;
        for (const m of r.matches) {
            m.round = canon.name;
            m.roundId = canon.rid;
        }
    });
    return leaves;
}

export { DEPTH, nextPow2 };
