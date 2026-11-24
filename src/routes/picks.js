// GET  /api/picks/open   — tour singles that are not locked, with my pick
// POST /api/picks        — { matchKey, playerKey }; lock check is one D1 upsert
// GET  /api/picks/mine   — my picks, newest first, with voidReason
// GET  /api/leaderboard  — display names, points, graded. No ids, emails, rank_gap.
//
// Grading reads the 2b cache overlay only. It does not call RapidAPI and it
// does not consult statusMemory.

import { cache } from '../cache.js';
import { readFixtures, readStandings } from '../d1Store.js';
import { readFixtureBoard } from './fixtures.js';
import { fixtureTier } from '../transforms/fixtureTier.js';
import { assertMember } from './auth.js';
import { rateLimit } from '../security.js';
import { picksNow } from '../picksClock.js';
import { lockDecision } from '../picksLock.js';
import { decideGrade, publicVoidReason } from '../picksGrade.js';
import { listPicks, lockPick, readPick, saveGrade, upsertPick } from '../picksStore.js';

const KEY_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const PICKS_PER_MINUTE = 60;

function httpError(message, status) {
    return Object.assign(new Error(message), { status });
}

function tierOf(row) {
    if (row?.tier === 'tour' || row?.tier === 'challenger' || row?.tier === 'itf') return row.tier;
    return fixtureTier({
        tournamentName: row?.tournamentName,
        rankName: row?.rankName,
        rankId: row?.rankId,
        eventType: row?.eventType,
    });
}

function isSingles(row) {
    const blob = `${row?.eventType || ''} ${row?.tournamentName || ''} ${row?.round || ''}`;
    if (/doubles/i.test(blob)) return false;
    if (String(row?.player1Name || '').includes('/') || String(row?.player2Name || '').includes('/')) return false;
    return true;
}

function isTourSingles(row) {
    return tierOf(row) === 'tour' && isSingles(row);
}

function playerKeys(row) {
    const p1 = row?.player1Key == null || row.player1Key === '' ? '' : String(row.player1Key);
    const p2 = row?.player2Key == null || row.player2Key === '' ? '' : String(row.player2Key);
    return [p1, p2];
}

async function loadBoard(env, nowMs) {
    const when = new Date(nowMs);
    const matches = [];
    const overlays = [];
    for (const tour of ['ATP', 'WTA']) {
        let saved = null;
        try { saved = await readFixtures(env, { tour }); } catch { saved = null; }
        const byKey = new Map();
        for (const row of saved?.rows || []) {
            if (!row?.matchKey) continue;
            byKey.set(String(row.matchKey), { ...row, tour: row.tour || tour });
        }
        let cached = null;
        try { cached = await cache.get(env, 'fixtures5', tour, 'all', '', ''); } catch { cached = null; }
        for (const row of Array.isArray(cached?.data) ? cached.data : []) {
            if (!row?.matchKey || byKey.has(String(row.matchKey))) continue;
            byKey.set(String(row.matchKey), { ...row, tour: row.tour || tour });
        }
        const board = await readFixtureBoard(env, { tour }, [...byKey.values()], when);
        for (const row of board.rows) {
            if (row?.matchKey) matches.push({ ...row, tour: row.tour || tour });
        }
        if (Array.isArray(board.overlays)) overlays.push(...board.overlays);
    }
    return { matches, overlays };
}

function gradeRow(schedule, overlays) {
    if (!schedule) return null;
    const key = String(schedule.matchKey);
    for (const overlay of overlays || []) {
        if (!overlay || String(overlay.matchKey || '') !== key) continue;
        const p1 = overlay.player1Key ?? overlay.player1Id;
        const p2 = overlay.player2Key ?? overlay.player2Id;
        if (p1 != null && p1 !== '' && p2 != null && p2 !== '') {
            return { ...schedule, player1Key: String(p1), player2Key: String(p2) };
        }
    }
    return schedule;
}

async function loadRanks(env) {
    const ranks = new Map();
    for (const tour of ['ATP', 'WTA']) {
        let saved = null;
        try { saved = await readStandings(env, tour); } catch { saved = null; }
        for (const row of saved?.rows || []) {
            const rank = Number(row?.rank);
            if (!row?.playerKey || !Number.isInteger(rank) || rank <= 0) continue;
            ranks.set(String(row.playerKey), rank);
        }
    }
    return ranks;
}

function rankGapFor(p1, p2, ranks) {
    const left = ranks.get(String(p1 || ''));
    const right = ranks.get(String(p2 || ''));
    if (!Number.isInteger(left) || !Number.isInteger(right)) return null;
    return Math.abs(left - right);
}

function seenAt(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function sameDecision(pick, decision) {
    return pick.result === decision.result
        && (pick.void_reason || '') === (decision.voidReason || '')
        && seenAt(pick.scoreless_first_seen_at) === seenAt(decision.firstSeenAt)
        && (pick.scoreless_status_as_of || '') === (decision.statusAsOf || '');
}

async function reconcileOne(env, pick, schedule, overlays, ranks, nowMs) {
    if (pick.locked_at == null) {
        const due = Number(pick.lock_at) <= nowMs
            || (schedule && lockDecision(schedule, nowMs).locked);
        if (due) {
            const [p1, p2] = playerKeys(schedule || {});
            const rankGap = rankGapFor(p1, p2, ranks);
            await lockPick(env, {
                lockedAt: nowMs,
                player1Key: p1,
                player2Key: p2,
                rankGap,
                memberId: pick.member_id,
                matchKey: pick.match_key,
            });
            pick.locked_at = nowMs;
            pick.player1_key = p1;
            pick.player2_key = p2;
            pick.rank_gap = rankGap;
        }
    }
    if (pick.locked_at == null || !schedule) return;
    if (pick.result === 'correct' || pick.result === 'wrong') return;
    if (pick.result === 'void' && (pick.void_reason === 'cancelled' || pick.void_reason === 'player_changed')) return;
    const decision = decideGrade(gradeRow(schedule, overlays), pick, nowMs);
    if (sameDecision(pick, decision)) return;
    await saveGrade(env, {
        result: decision.result,
        firstSeenAt: decision.firstSeenAt,
        statusAsOf: decision.statusAsOf,
        voidReason: decision.voidReason,
        memberId: pick.member_id,
        matchKey: pick.match_key,
    });
    pick.result = decision.result;
    pick.void_reason = decision.voidReason || '';
    pick.scoreless_first_seen_at = decision.firstSeenAt;
    pick.scoreless_status_as_of = decision.statusAsOf || '';
}

async function reconcileList(env, picks, board, nowMs) {
    if (!picks.length) return picks;
    const byKey = new Map(board.matches.map(row => [String(row.matchKey), row]));
    const ranks = await loadRanks(env);
    for (const pick of picks) {
        await reconcileOne(env, pick, byKey.get(String(pick.match_key)) || null, board.overlays, ranks, nowMs);
    }
    return picks;
}

function mineView(pick, match) {
    const [p1, p2] = playerKeys(match || {});
    const picked = String(pick.picked_player_key || '');
    const pickedName = picked && picked === p1
        ? (match?.player1Name || '')
        : picked === p2 ? (match?.player2Name || '') : '';
    return {
        matchKey: String(pick.match_key),
        tournamentName: match?.tournamentName || '',
        round: match?.round || '',
        status: match?.status || '',
        result: pick.result,
        voidReason: pick.result === 'void' ? publicVoidReason(pick.void_reason) : null,
        pickedPlayerKey: picked,
        pickedPlayerName: pickedName,
        player1Key: p1,
        player1Name: match?.player1Name || '',
        player2Key: p2,
        player2Name: match?.player2Name || '',
        updatedAt: Number(pick.updated_at),
        lockedAt: pick.locked_at == null ? null : Number(pick.locked_at),
    };
}

async function displayNameFor(env, email) {
    let user = null;
    try {
        user = await env.TENNIS_CACHE.get(`_user:${String(email).toLowerCase()}`, 'json');
    } catch { user = null; }
    const name = typeof user?.displayName === 'string' ? user.displayName.trim() : '';
    if (!name || name.includes('@') || name.length > 24) return 'Member';
    return name;
}

function leaderboardOf(picks, names) {
    const byMember = new Map();
    for (const pick of picks) {
        let row = byMember.get(pick.member_id);
        if (!row) row = byMember.set(pick.member_id, { points: 0, graded: 0, lastPick: 0 }).get(pick.member_id);
        const updated = Number(pick.updated_at) || 0;
        if (updated > row.lastPick) row.lastPick = updated;
        if (pick.result === 'correct') {
            row.points += 1;
            row.graded += 1;
        } else if (pick.result === 'wrong') row.graded += 1;
    }
    const ranked = [...byMember.entries()].filter(([, row]) => row.graded > 0);
    ranked.sort((a, b) => {
        if (b[1].points !== a[1].points) return b[1].points - a[1].points;
        const accuracy = (b[1].points * a[1].graded) - (a[1].points * b[1].graded);
        if (accuracy !== 0) return accuracy;
        if (a[1].lastPick !== b[1].lastPick) return a[1].lastPick - b[1].lastPick;
        return (names.get(a[0]) || '').localeCompare(names.get(b[0]) || '');
    });
    let rank = 0;
    let prev = '';
    return ranked.map(([memberId, row], index) => {
        const key = `${row.points}|${row.graded}|${row.lastPick}`;
        if (key !== prev) {
            rank = index + 1;
            prev = key;
        }
        return {
            rank,
            displayName: names.get(memberId) || 'Member',
            points: row.points,
            graded: row.graded,
        };
    });
}

async function readJson(request) {
    try {
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError('Invalid JSON', 400);
        return body;
    } catch (err) {
        if (err.status) throw err;
        throw httpError('Invalid JSON', 400);
    }
}

export async function handlePicksOpen(request, env) {
    const user = await assertMember(request, env);
    const nowMs = picksNow();
    const board = await loadBoard(env, nowMs);
    const picks = await reconcileList(env, await listPicks(env, user.email), board, nowMs);
    const matches = board.matches;
    const mine = new Map(picks.map(pick => [String(pick.match_key), pick]));
    const open = [];
    for (const match of matches) {
        if (!isTourSingles(match)) continue;
        const [p1, p2] = playerKeys(match);
        if (!p1 || !p2 || p1 === p2) continue;
        const decision = lockDecision(match, nowMs);
        if (decision.kind === 'unknown' || decision.locked) continue;
        const pick = mine.get(String(match.matchKey));
        open.push({
            matchKey: String(match.matchKey),
            tournamentKey: String(match.tournamentKey || ''),
            tournamentName: match.tournamentName || '',
            tour: match.tour || '',
            tier: 'tour',
            round: match.round || '',
            date: match.date || '',
            time: match.time || '',
            startsAtUtc: match.startsAtUtc || '',
            locksAtUtc: new Date(decision.lockAt).toISOString(),
            lockKind: decision.kind,
            status: match.status || 'Not Started',
            player1Key: p1,
            player1Name: match.player1Name || '',
            player2Key: p2,
            player2Name: match.player2Name || '',
            pick: pick ? String(pick.picked_player_key) : null,
        });
    }
    open.sort((a, b) => (a.locksAtUtc || '').localeCompare(b.locksAtUtc || '')
        || a.tournamentName.localeCompare(b.tournamentName)
        || a.matchKey.localeCompare(b.matchKey));
    return { matches: open };
}

export async function handlePicksSave(request, env) {
    const user = await assertMember(request, env);
    const body = await readJson(request);
    const matchKey = typeof body.matchKey === 'string' ? body.matchKey.trim() : '';
    const playerKey = typeof body.playerKey === 'string' ? body.playerKey.trim() : '';
    if (!KEY_RE.test(matchKey) || !KEY_RE.test(playerKey)) {
        throw httpError('matchKey and playerKey are required', 400);
    }
    await rateLimit(env, request, 'picks', {
        max: PICKS_PER_MINUTE,
        windowSec: 60,
        subject: user.email,
        retryAfter: true,
        message: (seconds) => `Too many changes. Try again in ${seconds}s.`,
    });
    const nowMs = picksNow();
    const { matches } = await loadBoard(env, nowMs);
    const match = matches.find(row => String(row.matchKey) === matchKey);
    if (!match || !isTourSingles(match)) throw httpError("That match isn't open for picks.", 400);
    const [p1, p2] = playerKeys(match);
    if (!p1 || !p2 || p1 === p2) throw httpError("That match isn't open for picks.", 400);
    if (playerKey !== p1 && playerKey !== p2) throw httpError('Pick one of the two players.', 400);
    const decision = lockDecision(match, nowMs);
    if (decision.kind === 'unknown') throw httpError("That match isn't open for picks.", 400);
    const wrote = await upsertPick(env, {
        memberId: user.email,
        matchKey,
        playerKey,
        createdAt: nowMs,
        updatedAt: nowMs,
        lockAt: decision.lockAt,
        tour: match.tour || '',
    }, nowMs);
    if (wrote !== 1) {
        const existing = await readPick(env, user.email, matchKey);
        const storedLocked = existing && (existing.locked_at != null || Number(existing.lock_at) <= nowMs);
        if (decision.locked || storedLocked) {
            await lockPick(env, {
                lockedAt: existing?.locked_at == null ? nowMs : existing.locked_at,
                player1Key: p1,
                player2Key: p2,
                rankGap: rankGapFor(p1, p2, await loadRanks(env)),
                memberId: user.email,
                matchKey,
            });
        }
        throw httpError('That match is locked.', 409);
    }
    const saved = await readPick(env, user.email, matchKey);
    return {
        matchKey,
        pickedPlayerKey: playerKey,
        result: saved?.result || 'pending',
        voidReason: null,
        locksAtUtc: new Date(decision.lockAt).toISOString(),
    };
}

export async function handlePicksMine(request, env) {
    const user = await assertMember(request, env);
    const nowMs = picksNow();
    const board = await loadBoard(env, nowMs);
    const picks = await reconcileList(env, await listPicks(env, user.email), board, nowMs);
    const byKey = new Map(board.matches.map(row => [String(row.matchKey), row]));
    const views = picks
        .slice()
        .sort((a, b) => Number(b.updated_at) - Number(a.updated_at) || String(b.match_key).localeCompare(String(a.match_key)))
        .map(pick => mineView(pick, byKey.get(String(pick.match_key))));
    return { picks: views };
}

export async function handleLeaderboard(request, env) {
    await assertMember(request, env);
    const nowMs = picksNow();
    const board = await loadBoard(env, nowMs);
    const picks = await reconcileList(env, await listPicks(env), board, nowMs);
    const names = new Map();
    for (const pick of picks) {
        if (names.has(pick.member_id)) continue;
        names.set(pick.member_id, await displayNameFor(env, pick.member_id));
    }
    return leaderboardOf(picks, names);
}
