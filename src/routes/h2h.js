import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL }      from '../config.js';
import { readMatchLog } from './playerMatches.js';

// GET /api/h2h?playerKeyA=47275&playerKeyB=33648&tour=ATP
//
// Uses the new RapidAPI (matching ID namespace used by /api/standings).
// Strategy:
//   - Fetch player A's last 200 matches, filter for matches vs player B
//   - Fetch H2H surface summary from rapidAPI.h2h
//   - Fetch current-year tournament calendar to get names + surfaces
//   - All three results are independently cached to minimise upstream calls

const TTL_CALENDAR = 24 * 60 * 60; // 24 hr — tournament names don't change

// Round ID → display label (from API research)
const ROUND_LABELS = {
    0: 'Pre-Qualifying', 1: 'Q1', 2: 'Q2', 3: 'Q3',
    4: 'R1', 5: 'R2', 6: 'R3', 7: 'R4',
    8: 'Round Robin', 9: 'Quarterfinal', 10: 'Semifinal',
    11: 'Bronze Medal', 12: 'Final',
};

function roundLabel(id) {
    return ROUND_LABELS[id] ?? (id != null ? `Round ${id}` : '');
}

// ── Surface normalisation ──────────────────────────────────────────────────────

function normSurface(court) {
    if (!court) return 'hard';
    const c = court.toLowerCase();
    if (c.includes('clay'))  return 'clay';
    if (c.includes('grass')) return 'grass';
    return 'hard';
}

// ── Tournament calendar (ID → {name, surface}) ─────────────────────────────────
// Fetches current + previous year so recent H2H history has names.

// v6: bumped after fixing calendar() pagination (was truncating to ~201 of
// ~900 tournaments/year, dropping most Slams/Masters from the map).
async function getTournamentMap(env, tour) {
    const ckey = ['tournament-map-v6', tour];
    const cached = await cache.get(env, ...ckey);
    if (cached) return cached.data;

    const year = new Date().getFullYear();
    const years = [year, year - 1, year - 2, year - 3, year - 4];

    const results = await Promise.allSettled(
        years.map(y => rapidAPI.calendar(env, tour, y))
    );

    const map = {};
    for (const res of results) {
        if (res.status !== 'fulfilled') continue;
        for (const t of (res.value?.data || [])) {
            if (t.id) map[t.id] = { name: t.name || '', surface: normSurface(t.court?.name) };
        }
    }

    await cache.set(env, TTL_CALENDAR, map, ...ckey);
    return map;
}

// ── Score string parser ────────────────────────────────────────────────────────
// Handles "6-3 6-4", "6-3 6-4(5)", "6-3, 6-4", etc.

function parseScore(result) {
    if (!result || typeof result !== 'string') return [];
    return result.trim()
        .split(/[\s,]+/)
        .map(s => {
            const tbMatch = s.match(/\((\d+)\)$/);
            const tb      = tbMatch ? parseInt(tbMatch[1]) : null;
            const clean   = s.replace(/\(\d+\)$/, '');
            const parts   = clean.split('-');
            if (parts.length !== 2) return null;
            const p1 = parseInt(parts[0], 10);
            const p2 = parseInt(parts[1], 10);
            if (isNaN(p1) || isNaN(p2)) return null;
            return {
                p1, p2,
                tiebreak: tb != null ? { p1: Math.max(p1, p2), p2: tb } : null,
            };
        })
        .filter(Boolean);
}

// ── Match transform ────────────────────────────────────────────────────────────

function transformMatch(m, tournamentMap) {
    const tId = m.tournamentId ?? m.tournament?.id;
    const t   = (tId != null ? tournamentMap[tId] : null) || {};

    // Prefer map lookup; fall back to inline tournament object from the match
    const tournamentName = t.name   || m.tournament?.name || '';
    const surface        = t.surface || normSurface(m.tournament?.court?.name) || null;

    return {
        matchKey:       String(m.id || ''),
        tournamentKey:  tId != null ? String(tId) : '',
        tournamentName,
        surface,
        date:           m.date ? m.date.split('T')[0] : '',
        round:          roundLabel(m.roundId),
        player1Key:     String(m.player1Id || ''),
        player1Name:    m.player1?.name || '',
        player2Key:     String(m.player2Id || ''),
        player2Name:    m.player2?.name || '',
        winner:         m.match_winner === m.player1Id ? 'First Player' : 'Second Player',
        finalResult:    m.result || '',
        setScores:      parseScore(m.result),
        status:         'Finished',
    };
}

// ── Surface splits transform ───────────────────────────────────────────────────
// rapidAPI.h2h returns [{court, player1wins, player2wins}] where player1
// corresponds to the first ID in the URL (playerKeyA).

function transformSurface(data) {
    const out = { all: { p1wins: 0, p2wins: 0 } };
    for (const row of (data || [])) {
        const surf = normSurface(row.court);
        const p1   = Number(row.player1wins) || 0;
        const p2   = Number(row.player2wins) || 0;
        // Accumulate — multiple API rows can map to the same surface (e.g. Hard + I.hard → hard)
        if (!out[surf]) out[surf] = { p1wins: 0, p2wins: 0 };
        out[surf].p1wins += p1;
        out[surf].p2wins += p2;
        out.all.p1wins   += p1;
        out.all.p2wins   += p2;
    }
    return out;
}

// ── KV (Sackmann-backed) match-log → H2H transform ──────────────────────────────
// The live API only sees a player's last ~200 matches and only knows current-era
// players, so retired opponents never surface. The KV match log (seeded from Jeff
// Sackmann's full archive via /api/admin/import-matches) carries the COMPLETE career
// in the same playerKey namespace ('s'+SackmannId for retired players). We read A's
// log, keep meetings vs B, and orient each so player1 = A.

const SACK_ROUND = {
    F: 'Final', SF: 'Semifinal', QF: 'Quarterfinal',
    R16: 'Round of 16', R32: 'Round of 32', R64: 'Round of 64', R128: 'Round of 128',
    RR: 'Round Robin', BR: 'Bronze Medal', Q1: 'Q1', Q2: 'Q2', Q3: 'Q3', ER: 'Early Round',
};
const sackRound = code => SACK_ROUND[code] || code || '';

// Sackmann `score` is always winner-first. Orient to the log owner (player1): if the
// owner lost, swap games per set so p1 = owner's games. The tiebreak object carries
// {games, tbPoints} and buildScoreStr reads it symmetrically, so it needs no swap.
function orientSetScores(rawScore, ownerWon) {
    const sets = parseScore(rawScore);
    return ownerWon ? sets : sets.map(s => ({ p1: s.p2, p2: s.p1, tiebreak: s.tiebreak }));
}

function transformKVMatch(rec, playerKeyA, playerKeyB) {
    return {
        matchKey:       rec.matchKey || '',
        tournamentKey:  '',                         // Sackmann tourney ids aren't in the draws namespace
        tournamentName: rec.tournamentName || '',
        surface:        rec.surface || null,
        date:           rec.date || '',
        round:          sackRound(rec.round),
        player1Key:     String(playerKeyA),
        player1Name:    '',                         // UI labels from its own selected-player objects
        player2Key:     String(playerKeyB),
        player2Name:    rec.opponentName || '',
        winner:         rec.won ? 'First Player' : 'Second Player',
        finalResult:    rec.score || '',
        setScores:      orientSetScores(rec.score, rec.won),
        status:         'Finished',
    };
}

// Surface splits over the final merged set, from player A's perspective. p1 = A.
function computeSplits(matches, playerKeyA) {
    const keyA = String(playerKeyA);
    const out  = { all: { p1wins: 0, p2wins: 0 } };
    for (const m of matches) {
        const surf = m.surface || 'hard';
        if (!out[surf]) out[surf] = { p1wins: 0, p2wins: 0 };
        const aIsP1 = m.player1Key === keyA;
        const aWon  = aIsP1 ? m.winner === 'First Player' : m.winner === 'Second Player';
        out[surf][aWon ? 'p1wins' : 'p2wins']++;
        out.all[aWon ? 'p1wins' : 'p2wins']++;
    }
    return out;
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function handleH2H(request, env) {
    const { searchParams } = new URL(request.url);
    const playerKeyA = searchParams.get('playerKeyA');
    const playerKeyB = searchParams.get('playerKeyB');
    const tour       = (searchParams.get('tour') || 'ATP').toUpperCase();

    if (!playerKeyA || !playerKeyB) throw new Error('playerKeyA and playerKeyB are required');

    // Cache key preserves A→B order so p1/p2 orientation is always consistent.
    // v10 bumped when the KV-backed complete-history merge landed.
    const cacheArgs = ['h2h-v10', tour, playerKeyA, playerKeyB];

    const cached = await cache.get(env, ...cacheArgs);
    if (cached) return cached.data;

    const pIdA = Number(playerKeyA);
    const pIdB = Number(playerKeyB);

    try {
        // KV log is the complete career (incl. retired opponents); the live API tops
        // up the in-progress season. Each source degrades independently.
        const [kvLog, pastResult, tMap] = await Promise.all([
            readMatchLog(env, tour, playerKeyA).catch(() => []),
            rapidAPI.playerPastMatches(env, tour, playerKeyA, 200).catch(() => null),
            getTournamentMap(env, tour).catch(() => ({})),
        ]);

        // ── Complete history from KV (Sackmann-backed) ───────────────────────────
        const kvMatches = (kvLog || [])
            .filter(m => String(m.opponentKey) === String(playerKeyB))
            .map(m => transformKVMatch(m, playerKeyA, playerKeyB));

        // A's most recent stored match date — the boundary past which we trust live.
        const cutoff = (kvLog || []).reduce((mx, m) => (m.date > mx ? m.date : mx), '');

        // ── Live API — only matches newer than the Sackmann cutoff (no overlap) ──
        const allMatches = pastResult?.data || [];
        const liveMatches = allMatches
            .filter(m =>
                (m.player1Id === pIdA && m.player2Id === pIdB) ||
                (m.player1Id === pIdB && m.player2Id === pIdA)
            )
            .map(m => transformMatch(m, tMap || {}))
            .filter(m => !cutoff || m.date > cutoff);

        const h2hMatches = [...kvMatches, ...liveMatches];

        const data = {
            h2hMatches,
            surfaceSplits: computeSplits(h2hMatches, playerKeyA),
        };

        await cache.set(env, TTL.h2h, data, ...cacheArgs);
        return data;

    } catch (err) {
        const stale = await cache.getStale(env, ...cacheArgs);
        if (stale) return stale.data;
        throw err;
    }
}
