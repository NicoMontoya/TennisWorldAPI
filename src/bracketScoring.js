// ===================================
// TennisWorld — Bracket scoring (pure)
// ===================================
// Scores a user's picks against the official draw rounds.
//
// Rules (v1, "round-weighted"):
//   - A correct pick on a decided match earns 2^columnIdx points, where
//     columnIdx 0 = the first round the API delivered (R128 → F = 1..64).
//     On a full draw every round is worth the same total (64 × 1 = 1 × 64).
//   - maxPossible = score + the weights of undecided picked matches whose
//     picked player has not been eliminated (lost a decided match).
//   - accuracy = correct / decided picks (null when nothing decided yet).
//
// Pick keys: real matchKey for matches that existed when the user saved, or
// positional '__inf_{col}_{slot}' for rounds that were still projected. The
// positional fallback here mirrors TennisWorldUI/components/BracketPicks.js
// (keep the two in sync): column/slot indexes are deterministic because
// matches sort matchKey-ascending within a round and the base column is the
// first delivered round.

const RID_TO_IDX = { 4: 0, 5: 1, 6: 2, 7: 3, 9: 4, 10: 5, 12: 6 };

function isRealKey(key) {
    return key != null && key !== '' && key !== 'null' && key !== 'undefined';
}

function winnerKeyOf(m) {
    if (m.winner === 'player1') return String(m.player1Key);
    if (m.winner === 'player2') return String(m.player2Key);
    return null;
}

function loserKeyOf(m) {
    if (m.winner === 'player1') return String(m.player2Key);
    if (m.winner === 'player2') return String(m.player1Key);
    return null;
}

// Bucket rounds by roundId, sorted matchKey-ascending (mirrors DrawBracket /
// BracketPicks slot order).
function bucketRounds(rounds) {
    const byRound = {};
    for (const r of rounds || []) {
        for (const m of (r.matches || [])) {
            const rid = Number(m.roundId);
            if (RID_TO_IDX[rid] === undefined) continue;
            (byRound[rid] = byRound[rid] || []).push(m);
        }
    }
    const roundIds = Object.keys(byRound).map(Number)
        .sort((a, b) => RID_TO_IDX[a] - RID_TO_IDX[b]);
    for (const rid of roundIds) {
        byRound[rid].sort((a, b) => Number(a.matchKey) - Number(b.matchKey));
    }
    return { byRound, roundIds };
}

/**
 * computeBracketScore(rounds, picks, retro) →
 *   { score, maxPossible, correct, decided, totalPicks, accuracy }
 *
 * retro: { [pickKey]: true } — picks first created AFTER their match was
 * already decided (late entrants filling the canvas). Stored for display and
 * compare, but excluded from score/maxPossible/decided/accuracy so hindsight
 * can never earn points.
 */
export function computeBracketScore(rounds, picks, retro) {
    picks = picks || {};
    retro = retro || {};
    const { byRound, roundIds } = bucketRounds(rounds);
    const empty = { score: 0, maxPossible: 0, correct: 0, decided: 0, totalPicks: 0, accuracy: null };
    if (!roundIds.length) return empty;

    const baseIdx = RID_TO_IDX[roundIds[0]];
    const drawSize = byRound[roundIds[0]].length;
    const isPow2 = drawSize > 0 && (drawSize & (drawSize - 1)) === 0;
    const numColumns = isPow2 ? Math.round(Math.log2(drawSize)) + 1 : roundIds.length;

    // Players eliminated by a decided result anywhere in the draw.
    const eliminated = new Set();
    for (const rid of roundIds) {
        for (const m of byRound[rid]) {
            const l = loserKeyOf(m);
            if (isRealKey(l)) eliminated.add(l);
        }
    }

    let score = 0, potential = 0, correct = 0, decided = 0, totalPicks = 0;
    const seenCols = new Set();

    for (const rid of roundIds) {
        const ci = RID_TO_IDX[rid] - baseIdx;
        if (ci < 0) continue;
        seenCols.add(ci);
        const w = Math.pow(2, ci);
        byRound[rid].forEach((m, si) => {
            let usedKey = String(m.matchKey);
            let pick = picks[usedKey];
            if (!isRealKey(pick)) { usedKey = '__inf_' + ci + '_' + si; pick = picks[usedKey]; }
            if (!isRealKey(pick)) return;
            pick = String(pick);
            totalPicks++;
            if (retro[usedKey]) return; // display-only — hindsight never scores
            const actual = winnerKeyOf(m);
            if (actual != null) {
                decided++;
                if (actual === pick) { score += w; correct++; }
            } else if (!eliminated.has(pick)) {
                potential += w;
            }
        });
    }

    // Rounds not yet delivered by the API: only positional picks can exist.
    for (let ci = 0; ci < numColumns && (baseIdx + ci) <= 6; ci++) {
        if (seenCols.has(ci)) continue;
        const w = Math.pow(2, ci);
        const slotsInCol = Math.max(1, drawSize >> ci);
        for (let si = 0; si < slotsInCol; si++) {
            const pick = picks['__inf_' + ci + '_' + si];
            if (!isRealKey(pick)) continue;
            totalPicks++;
            if (!eliminated.has(String(pick))) potential += w;
        }
    }

    return {
        score,
        maxPossible: score + potential,
        correct,
        decided,
        totalPicks,
        accuracy: decided ? Math.round((correct / decided) * 1000) / 10 : null,
    };
}

/**
 * positionalKeyMap(rounds) → Map('__inf_{col}_{slot}' → real matchKey) for every
 * DELIVERED match. Used by the save handler to normalize positional picks so the
 * decided-match lock cannot be bypassed via '__inf' keys (they'd score through
 * the positional fallback otherwise).
 */
export function positionalKeyMap(rounds) {
    const { byRound, roundIds } = bucketRounds(rounds);
    const map = new Map();
    if (!roundIds.length) return map;
    const baseIdx = RID_TO_IDX[roundIds[0]];
    for (const rid of roundIds) {
        const ci = RID_TO_IDX[rid] - baseIdx;
        if (ci < 0) continue;
        byRound[rid].forEach((m, si) => {
            map.set('__inf_' + ci + '_' + si, String(m.matchKey));
        });
    }
    return map;
}

export { RID_TO_IDX };
