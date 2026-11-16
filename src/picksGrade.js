// Grade a pick from the recorded winner only. Status text never awards a point.
// A scoreless walkover stays pending until 15 minutes have passed and a newer
// feed statusAsOf is still scoreless. A retirement with a winner counts with
// or without set scores.

export const SCORELESS_CONFIRM_MS = 15 * 60 * 1000;

import { applyFixtureOverlay, matchFeedCategory } from './transforms/fixturesFeed.js';

const VOID_REASONS = new Set(['walkover', 'cancelled', 'player_changed']);

export function publicVoidReason(reason) {
    return VOID_REASONS.has(reason) ? reason : null;
}

function side(row, key) {
    const value = row?.[key];
    if (value == null || value === '') return '';
    return String(value);
}

function pair(a, b) {
    return [a, b].filter(Boolean);
}

function samePlayers(left, right) {
    if (left.length !== 2 || right.length !== 2) return false;
    return (left[0] === right[0] && left[1] === right[1])
        || (left[0] === right[1] && left[1] === right[0]);
}

function scoreText(row) {
    for (const key of ['score', 'finalResult']) {
        if (typeof row?.[key] === 'string' && row[key].trim()) return row[key].trim();
    }
    return '';
}

export function hasSetScores(row) {
    const scores = row?.setScores;
    if (Array.isArray(scores)) {
        for (const item of scores) {
            if (typeof item === 'string' && /\d/.test(item)) return true;
            if (typeof item === 'number' && Number.isFinite(item)) return true;
            if (item && typeof item === 'object') {
                const p1 = Number(item.p1);
                const p2 = Number(item.p2);
                if ((Number.isFinite(p1) && p1 > 0) || (Number.isFinite(p2) && p2 > 0)) return true;
            }
        }
    }
    const text = scoreText(row);
    if (!text || /w\s*\/\s*o|walkover/i.test(text)) return false;
    return /\d/.test(text);
}

function winnerKey(row) {
    const winner = row?.winner == null ? '' : String(row.winner).trim();
    if (!winner) return '';
    const played = pair(side(row, 'player1Key'), side(row, 'player2Key'));
    return played.includes(winner) ? winner : '';
}

function recordedWalkoverScore(row) {
    return /w\s*\/\s*o|walkover/i.test(scoreText(row));
}

// Post-overlay, a retirement before the first game is Finished with a winner
// and no sets. The feed word "retired"/"Ret." is the same thing before overlay.
// The feed word "Finished" with a winner and no sets is an inferred walkover,
// which the overlay rewrites to status Walkover, so it does not land here.
function isRetirement(row, winner) {
    if (!winner || hasSetScores(row)) return false;
    if (matchFeedCategory(row) === 'retired') return true;
    return row?.status === 'Finished' && matchFeedCategory(row) !== 'walkover';
}

function asOfMs(value) {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function outcome(result, voidReason, firstSeenAt, statusAsOf) {
    const seen = firstSeenAt == null || firstSeenAt === '' ? null : Number(firstSeenAt);
    return {
        result,
        voidReason: result === 'void' ? voidReason : '',
        firstSeenAt: Number.isFinite(seen) ? seen : null,
        statusAsOf: typeof statusAsOf === 'string' ? statusAsOf : '',
    };
}

/**
 * @param {object} row overlaid match, or a golden row after overlay
 * @param {object} pick stored pick (player snapshot, scoreless fields, result)
 * @param {number} [now] server clock
 */
export function decideGrade(row, pick, now = Date.now()) {
    const firstSeen = pick?.scoreless_first_seen_at == null || pick.scoreless_first_seen_at === ''
        ? null
        : Number(pick.scoreless_first_seen_at);
    const recordedAsOf = typeof pick?.scoreless_status_as_of === 'string' ? pick.scoreless_status_as_of : '';
    const played = pair(side(row, 'player1Key'), side(row, 'player2Key'));
    const locked = pair(pick?.player1_key, pick?.player2_key);
    const picked = side(pick, 'picked_player_key');

    if (locked.length === 2 && played.length === 2 && !samePlayers(locked, played)) {
        return outcome('void', 'player_changed', firstSeen, recordedAsOf);
    }
    if (locked.length === 2 && played.length === 2 && picked && !played.includes(picked)) {
        return outcome('void', 'player_changed', firstSeen, recordedAsOf);
    }

    const category = matchFeedCategory(row);
    if (row?.status === 'Cancelled' || category === 'cancelled') {
        return outcome('void', 'cancelled', firstSeen, recordedAsOf);
    }

    const winner = winnerKey(row);
    if (winner && (hasSetScores(row) || isRetirement(row, winner))) {
        return outcome(winner === picked ? 'correct' : 'wrong', '', null, '');
    }

    if (recordedWalkoverScore(row)) {
        return outcome('void', 'walkover', firstSeen, recordedAsOf);
    }

    const scorelessWalkover = !hasSetScores(row) && (row?.status === 'Walkover' || category === 'walkover');
    if (scorelessWalkover) {
        const currentAsOf = typeof row?.statusAsOf === 'string' ? row.statusAsOf : '';
        if (pick?.result === 'void' && pick?.void_reason === 'walkover') {
            return outcome('void', 'walkover', firstSeen, recordedAsOf);
        }
        if (!Number.isFinite(firstSeen)) return outcome('pending', '', now, currentAsOf);
        const currentMs = asOfMs(currentAsOf);
        const recordedMs = asOfMs(recordedAsOf);
        const newerFeed = currentMs != null && (recordedMs == null || currentMs > recordedMs);
        if (now - firstSeen >= SCORELESS_CONFIRM_MS && newerFeed) {
            return outcome('void', 'walkover', firstSeen, recordedAsOf);
        }
        return outcome('pending', '', firstSeen, recordedAsOf);
    }

    return outcome(pick?.result === 'void' ? 'void' : 'pending', pick?.void_reason || '', firstSeen, recordedAsOf);
}

function setsFromScore(score) {
    const text = String(score || '').trim();
    if (!text || /w\s*\/\s*o|walkover/i.test(text)) return [];
    return text.split(/\s+/).filter(token => /\d/.test(token));
}

function codeOf(result) {
    if (result === 'correct') return 1;
    if (result === 'wrong') return 0;
    if (result === 'void') return null;
    return 'pending';
}

function sameExpected(got, expected) {
    if (expected === 'pending') return got === 'pending';
    return got === expected;
}

/** Sackmann golden rows. Score "W/O" voids; RET with a winner grades. */
export function replayHistorical(rows) {
    let wrong = 0;
    for (const row of rows || []) {
        const score = String(row.score || '');
        const walkover = /w\s*\/\s*o|walkover/i.test(score) || !score.trim();
        const match = {
            player1Key: row.picks.winner,
            player2Key: row.picks.loser,
            winner: row.picks.winner,
            status: walkover ? 'Walkover' : 'Finished',
            score,
            setScores: setsFromScore(score),
        };
        const passes = walkover && !/w\s*\/\s*o|walkover/i.test(score) ? 2 : 1;
        const origin = Date.parse('2026-01-18T12:00:00.000Z');
        for (const kind of ['winner', 'loser', 'favorite', 'random']) {
            let state = {
                picked_player_key: row.picks[kind],
                player1_key: row.picks.winner,
                player2_key: row.picks.loser,
                scoreless_first_seen_at: null,
                scoreless_status_as_of: '',
                result: 'pending',
                void_reason: '',
            };
            let decision;
            for (let i = 0; i < passes; i++) {
                decision = decideGrade({
                    ...match,
                    statusAsOf: new Date(origin + i * 60_000).toISOString(),
                }, state, origin + i * SCORELESS_CONFIRM_MS);
                state = {
                    ...state,
                    result: decision.result,
                    void_reason: decision.voidReason,
                    scoreless_first_seen_at: decision.firstSeenAt,
                    scoreless_status_as_of: decision.statusAsOf,
                };
            }
            if (!sameExpected(codeOf(decision.result), row.expected[kind])) wrong += 1;
        }
    }
    return wrong;
}

function overlayGolden(entry) {
    const base = {
        matchKey: entry.id || String(entry.match_num || 'm'),
        player1Key: entry.playedPlayers[0],
        player2Key: entry.playedPlayers[1],
        tournamentKey: '1',
        roundId: 1,
        status: 'Not Started',
        winner: '',
        setScores: [],
    };
    const feed = {
        matchKey: base.matchKey,
        player1Key: entry.playedPlayers[0],
        player2Key: entry.playedPlayers[1],
        tournamentKey: '1',
        roundId: 1,
        status: entry.status,
        statusText: entry.status,
        winner: entry.winner,
        setScores: setsFromScore(entry.score),
    };
    const [merged] = applyFixtureOverlay([base], [feed], { now: new Date('2026-11-16T12:00:00.000Z') });
    return { ...merged, score: entry.score || '', player1Key: entry.playedPlayers[0], player2Key: entry.playedPlayers[1] };
}

function refreshesFor(entry, merged) {
    if (entry.seenScorelessCount != null) return Number(entry.seenScorelessCount);
    const scoreless = !hasSetScores({ ...merged, score: entry.score || '' }) && !String(entry.score || '').trim();
    if (scoreless && (merged.status === 'Walkover' || entry.status === 'Walkover')) return 2;
    return 1;
}

/** Synthetic Finals cases, including the two-refresh walkover and a swap. */
export function replayFinals(cases) {
    let wrong = 0;
    const reasons = [];
    for (const entry of cases || []) {
        const merged = overlayGolden(entry);
        const passes = refreshesFor(entry, merged);
        const origin = Date.parse('2026-11-16T12:00:00.000Z');
        let state = {
            picked_player_key: entry.pick,
            player1_key: entry.lockPlayers[0],
            player2_key: entry.lockPlayers[1],
            scoreless_first_seen_at: null,
            scoreless_status_as_of: '',
            result: 'pending',
            void_reason: '',
        };
        let decision;
        for (let i = 0; i < passes; i++) {
            decision = decideGrade({
                ...merged,
                statusAsOf: new Date(origin + i * 60_000).toISOString(),
            }, state, origin + i * SCORELESS_CONFIRM_MS);
            state = {
                ...state,
                result: decision.result,
                void_reason: decision.voidReason,
                scoreless_first_seen_at: decision.firstSeenAt,
                scoreless_status_as_of: decision.statusAsOf,
            };
        }
        if (!sameExpected(codeOf(decision.result), entry.expected)) wrong += 1;
        reasons.push({ id: entry.id, result: decision.result, voidReason: decision.voidReason || '' });
    }
    return { wrong, reasons };
}
