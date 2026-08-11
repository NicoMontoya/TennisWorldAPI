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

// Winner playerKey of a decided match, else null.
function winnerKeyOf(m) {
    if (m.winner === 'player1') return String(m.player1Key);
    if (m.winner === 'player2') return String(m.player2Key);
    return null;
}
function isRealKey(k) { return k != null && k !== '' && k !== 'null' && k !== 'undefined'; }

/**
 * expandByes(rounds, leaves) — for a draw with byes (Masters 96, 48, 56…), the
 * earliest round is narrower than a full tree (a 96-draw's play-in is 32 real
 * matches, but the bracket has 64 first-round slots — the other 32 are seeds
 * who received byes). This rebuilds the earliest round to its FULL width by
 * threading it from the SECOND round: each second-round player either won a
 * play-in match (that match becomes their feeder slot) or entered on a bye (a
 * synthetic "seed vs BYE" match, seed auto-advanced, is placed in that slot).
 *
 * The result: the earliest round has exactly leaves/2 slots in an order that
 * connects correctly to the second round (slots 2j, 2j+1 feed second-round slot
 * j). The client then derives the true draw size from the now-full first round
 * and renders the complete tree — byes included — with no special-casing.
 *
 * No-op when the earliest round is already full width (128/64/32 draws) or when
 * there is no second round to thread from. Mutates `rounds`; returns it.
 */
export function expandByes(rounds, leaves) {
    if (!rounds || rounds.length < 2 || !leaves) return rounds;
    const ordered = rounds.slice().sort((a, b) => b.order - a.order); // earliest first
    const earliest = ordered[0];
    const second   = ordered[1];
    const fullWidth = leaves / 2;
    if (!earliest.matches.length || earliest.matches.length >= fullWidth) return rounds; // no byes

    // Map each play-in winner → the match they won (their feeder slot).
    const winnerToMatch = new Map();
    for (const m of earliest.matches) {
        const wk = winnerKeyOf(m);
        if (wk) winnerToMatch.set(wk, m);
    }

    const template = earliest.matches[0];
    const rid = template.roundId;
    const roundName = earliest.round;
    let byeSeq = 0;

    const byeMatch = (key, name, seed) => ({
        ...template,
        matchKey:    `bye-${rid}-${byeSeq++}`,
        player1Name: name || '',
        player1Key:  isRealKey(key) ? String(key) : '',
        player1Seed: seed != null ? seed : null,
        player2Name: 'BYE',
        player2Key:  '',
        player2Seed: null,
        player1Rank: null,
        player2Rank: null,
        winner:      isRealKey(key) ? 'player1' : null,   // seed auto-advances
        setScores:   [],
        status:      isRealKey(key) ? 'Finished' : 'Not Started',
        isLive:      false,
        isBye:       true,
        synthetic:   true,
    });
    const tbdMatch = () => ({
        ...template, matchKey: `bye-${rid}-${byeSeq++}`,
        player1Name: 'TBD', player1Key: '', player1Seed: null,
        player2Name: 'TBD', player2Key: '', player2Seed: null,
        player1Rank: null, player2Rank: null,
        winner: null, setScores: [], status: 'Not Started', isLive: false, synthetic: true,
    });

    // Thread the earliest round from the second round's players, in slot order.
    const feeders = [];
    for (const sm of second.matches) {
        for (const side of ['player1', 'player2']) {
            const key = String(sm[`${side}Key`] ?? '');
            const name = sm[`${side}Name`] || '';
            const seed = sm[`${side}Seed`];
            if (isRealKey(key) && winnerToMatch.has(key)) {
                feeders.push(winnerToMatch.get(key));   // they won a play-in match
            } else if (isRealKey(key)) {
                feeders.push(byeMatch(key, name, seed)); // entered on a bye
            } else {
                feeders.push(tbdMatch());                // unknown feeder (data gap)
            }
        }
    }
    // Any real play-in matches not threaded above (shouldn't happen, but keep
    // them rather than drop) + pad to full width with TBD.
    const used = new Set(feeders);
    for (const m of earliest.matches) if (!used.has(m)) feeders.push(m);
    while (feeders.length < fullWidth) feeders.push(tbdMatch());

    for (const m of feeders) { m.round = roundName; m.roundId = rid; }
    earliest.matches = feeders.slice(0, fullWidth);
    return rounds;
}

export { DEPTH, nextPow2 };
