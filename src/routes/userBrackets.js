// ===================================
// TennisWorld — User Bracket Routes (account-saved brackets + leaderboard)
// ===================================
// POST /api/bracket/save     — save the authed user's bracket for a tournament
// GET  /api/bracket/mine     — the authed user's brackets (+ live scores)
// GET  /api/bracket/leaders  — per-tournament leaderboard (public)
// GET  /api/bracket/public   — one user's picks, read-only by publicId (public)
//
// Design contract (increment-4 ISA):
//   - User picks NEVER touch official draw data. This module writes only
//     `_ubracket*`, `_upub:*` keys (plus `_lb:*` leaderboard cache) and the
//     user record (publicId mint). Official draws are read-only inputs.
//   - One active server bracket per user per tournament (local named brackets
//     remain a client-side feature).
//   - Anti point-farming: a pick for an already-decided match can never be
//     created or changed — the previously-saved value (if any) is kept.
//   - Leaderboard/public payloads expose publicId + displayName only. Never
//     emails (user ids are emails internally).

import { getAuthUser, saveUser } from './auth.js';
import { handleDraws } from './draws.js';
import { computeBracketScore, positionalKeyMap } from '../bracketScoring.js';

const MAX_PICKS = 300;
const LEADERS_TTL_MS = 5 * 60 * 1000;   // recompute leaderboard at most every 5 min
const LEADERS_LIMIT = 50;

// ── KV keys ───────────────────────────────────────────────────────────────────
const kBracket = (tour, tk, userId) => `_ubracket:${tour}:${tk}:${userId}`;
const kUserLst = (userId)           => `_ubracket-user:${userId}`;
const kPublic  = (publicId)         => `_upub:${publicId}`;
const kLeaders = (tour, tk)         => `_lb:${tour}:${tk}`;

function bad(msg, status = 400) {
    throw Object.assign(new Error(msg), { status });
}

function displayNameOf(user) {
    const first = (user.firstName || '').trim();
    const last  = (user.lastName || '').trim();
    return (first + ' ' + (last ? last[0] + '.' : '')).trim() || 'Player';
}

async function fetchRounds(env, tour, tournamentKey) {
    const req = new Request(
        `https://placeholder/api/draws?tournamentKey=${encodeURIComponent(tournamentKey)}&tour=${encodeURIComponent(tour)}`
    );
    const data = await handleDraws(req, env);
    return (data && data.rounds) || [];
}

function decidedWinners(rounds) {
    // matchKey → actual winner playerKey, for every decided match.
    const map = new Map();
    for (const r of rounds) {
        for (const m of (r.matches || [])) {
            if (m.winner === 'player1') map.set(String(m.matchKey), String(m.player1Key));
            if (m.winner === 'player2') map.set(String(m.matchKey), String(m.player2Key));
        }
    }
    return map;
}

// ── POST /api/bracket/save ────────────────────────────────────────────────────
export async function handleBracketSave(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) bad('Unauthorized', 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') bad('JSON body required');
    const tour = String(body.tour || 'ATP').toUpperCase();
    const tk = String(body.tournamentKey || '').trim();
    const season = String(body.season || '').trim();
    const tournamentName = String(body.tournamentName || '').slice(0, 120);
    const picks = body.picks;
    if (!tk || !/^[\w-]{1,40}$/.test(tk)) bad('tournamentKey is required');
    if (!picks || typeof picks !== 'object' || Array.isArray(picks)) bad('picks object is required');
    const entries = Object.entries(picks);
    if (entries.length > MAX_PICKS) bad(`too many picks (max ${MAX_PICKS})`);
    for (const [k, v] of entries) {
        if (typeof k !== 'string' || k.length > 40 || typeof v !== 'string' || v.length > 40)
            bad('picks must map short string match keys to short string player keys');
    }

    // Validate tournament + build the decided-match lock set.
    let rounds;
    try {
        rounds = await fetchRounds(env, tour, tk);
    } catch (_) {
        bad('unknown tournament (draw unavailable)');
    }
    if (!rounds.length) bad('unknown tournament (no draw data)');

    const decided = decidedWinners(rounds);
    const key = kBracket(tour, tk, user.email);
    const prior = await env.TENNIS_CACHE.get(key, 'json');

    // Normalize positional '__inf_{col}_{slot}' keys to real matchKeys where the
    // round has materialized — otherwise a positional pick on a decided slot
    // would slip past the lock below and score via the positional fallback.
    const posMap = positionalKeyMap(rounds);
    const norm = k => posMap.get(k) || k;

    // Anti point-farming: a pick on an already-decided match keeps its prior
    // value when one exists; a NEW pick on a decided match is stored (so the
    // from-scratch canvas survives reload/compare) but flagged retro — it can
    // never earn points. Retro flags stick for the bracket's lifetime.
    const cleanPicks = {};
    const retroFlags = {};
    const priorRetro = (prior && prior.retro) || {};
    for (const [k, v] of entries) {
        const nk = norm(k);
        if (decided.has(nk)) {
            const prev = prior && prior.picks && (prior.picks[nk] || prior.picks[k]);
            if (prev) {
                cleanPicks[nk] = String(prev);
                if (priorRetro[nk] || priorRetro[k]) retroFlags[nk] = true;
            } else {
                cleanPicks[nk] = String(v);
                retroFlags[nk] = true; // created with hindsight — display-only
            }
        } else if (cleanPicks[nk] === undefined) {
            cleanPicks[nk] = String(v);
        }
    }
    // Prior picks on decided matches are preserved even if omitted from the payload.
    if (prior && prior.picks) {
        for (const [k, v] of Object.entries(prior.picks)) {
            const nk = norm(k);
            if (decided.has(nk) && cleanPicks[nk] === undefined) {
                cleanPicks[nk] = String(v);
                if (priorRetro[nk] || priorRetro[k]) retroFlags[nk] = true;
            }
        }
    }

    // Mint a stable publicId on first save (leaderboard identity — never email).
    if (!user.publicId) {
        user.publicId = crypto.randomUUID();
        await saveUser(env, user);
        await env.TENNIS_CACHE.put(kPublic(user.publicId), JSON.stringify({ email: user.email }));
    }

    const record = {
        userId: user.email,
        publicId: user.publicId,
        displayName: displayNameOf(user),
        tour, tournamentKey: tk, season, tournamentName,
        picks: cleanPicks,
        retro: retroFlags,
        updatedAt: new Date().toISOString(),
    };
    await env.TENNIS_CACHE.put(key, JSON.stringify(record));

    // NOTE: no shared tournament-index blob — KV read-modify-write races drop
    // concurrent first-saves (last writer wins). The leaderboard enumerates
    // brackets with a prefix list() instead, which has no lost-update problem.
    // Per-user tournament list — upsert (single-owner key, race-safe enough).
    const lst = (await env.TENNIS_CACHE.get(kUserLst(user.email), 'json')) || [];
    const li = lst.findIndex(e => e.tour === tour && e.tournamentKey === tk);
    const meta = { tour, tournamentKey: tk, season, tournamentName, updatedAt: record.updatedAt };
    if (li >= 0) lst[li] = meta; else lst.push(meta);
    await env.TENNIS_CACHE.put(kUserLst(user.email), JSON.stringify(lst));

    // Invalidate the leaderboard cache so the save shows up promptly.
    await env.TENNIS_CACHE.delete(kLeaders(tour, tk));

    const scored = computeBracketScore(rounds, cleanPicks, retroFlags);
    return { saved: true, picksSaved: Object.keys(cleanPicks).length,
             retroCount: Object.keys(retroFlags).length, ...scored };
}

// ── GET /api/bracket/mine ─────────────────────────────────────────────────────
// ?tour&tournamentKey → that single bracket (with picks). No params → list of
// all the user's brackets with current scores.
export async function handleBracketMine(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) bad('Unauthorized', 401);
    const { searchParams } = new URL(request.url);
    const tk = searchParams.get('tournamentKey');
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    if (tk) {
        const rec = await env.TENNIS_CACHE.get(kBracket(tour, tk, user.email), 'json');
        if (!rec) return { bracket: null };
        let scored = null;
        try { scored = computeBracketScore(await fetchRounds(env, tour, tk), rec.picks, rec.retro); } catch (_) {}
        return { bracket: { ...rec, userId: undefined, ...(scored || {}) } };
    }

    const lst = (await env.TENNIS_CACHE.get(kUserLst(user.email), 'json')) || [];
    const out = [];
    for (const meta of lst.slice(0, 50)) {
        const rec = await env.TENNIS_CACHE.get(kBracket(meta.tour, meta.tournamentKey, user.email), 'json');
        if (!rec) continue;
        let scored = null;
        try { scored = computeBracketScore(await fetchRounds(env, meta.tour, meta.tournamentKey), rec.picks, rec.retro); } catch (_) {}
        out.push({
            tour: meta.tour, tournamentKey: meta.tournamentKey, season: meta.season,
            tournamentName: meta.tournamentName, updatedAt: rec.updatedAt,
            picksTotal: Object.keys(rec.picks || {}).length,
            ...(scored || {}),
        });
    }
    out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { brackets: out };
}

// ── GET /api/bracket/leaders ──────────────────────────────────────────────────
export async function handleBracketLeaders(request, env) {
    const { searchParams } = new URL(request.url);
    const tk = searchParams.get('tournamentKey');
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();
    if (!tk) bad('tournamentKey is required');

    const cached = await env.TENNIS_CACHE.get(kLeaders(tour, tk), 'json');
    if (cached && Date.now() - cached.computedAt < LEADERS_TTL_MS) {
        return { ...cached.payload, cached: true };
    }

    // Enumerate brackets by KV prefix — no shared index blob, no lost updates.
    const prefix = `_ubracket:${tour}:${tk}:`;
    const keys = [];
    let cursor;
    do {
        const page = await env.TENNIS_CACHE.list({ prefix, cursor, limit: 1000 });
        keys.push(...page.keys.map(k => k.name));
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && keys.length < 500);
    if (!keys.length) return { entries: [], total: 0 };

    const rounds = await fetchRounds(env, tour, tk);
    const entries = [];
    for (const keyName of keys.slice(0, 500)) {
        const rec = await env.TENNIS_CACHE.get(keyName, 'json');
        if (!rec) continue;
        const scored = computeBracketScore(rounds, rec.picks, rec.retro);
        entries.push({
            publicId: rec.publicId,
            displayName: rec.displayName,
            score: scored.score,
            maxPossible: scored.maxPossible,
            accuracy: scored.accuracy,
            correct: scored.correct,
            decided: scored.decided,
            picksTotal: scored.totalPicks,
            updatedAt: rec.updatedAt,
        });
    }
    entries.sort((a, b) => b.score - a.score || b.maxPossible - a.maxPossible || (a.updatedAt || '').localeCompare(b.updatedAt || ''));
    entries.forEach((e, i) => { e.rank = i + 1; });

    const payload = { entries: entries.slice(0, LEADERS_LIMIT), total: entries.length };
    await env.TENNIS_CACHE.put(kLeaders(tour, tk), JSON.stringify({ computedAt: Date.now(), payload }),
        { expirationTtl: 3600 });
    return payload;
}

// ── GET /api/bracket/public ───────────────────────────────────────────────────
export async function handleBracketPublic(request, env) {
    const { searchParams } = new URL(request.url);
    const publicId = searchParams.get('id') || '';
    const tk = searchParams.get('tournamentKey');
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();
    if (!publicId || !/^[\w-]{8,64}$/.test(publicId)) bad('id is required');
    if (!tk) bad('tournamentKey is required');

    const pub = await env.TENNIS_CACHE.get(kPublic(publicId), 'json');
    if (!pub) bad('bracket not found', 404);
    const rec = await env.TENNIS_CACHE.get(kBracket(tour, tk, pub.email), 'json');
    if (!rec) bad('bracket not found', 404);

    let scored = null;
    try { scored = computeBracketScore(await fetchRounds(env, tour, tk), rec.picks, rec.retro); } catch (_) {}
    return {
        displayName: rec.displayName,
        publicId: rec.publicId,
        tour: rec.tour, tournamentKey: rec.tournamentKey, season: rec.season,
        picks: rec.picks,
        updatedAt: rec.updatedAt,
        ...(scored || {}),
    };
}
