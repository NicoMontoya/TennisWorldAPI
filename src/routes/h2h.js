import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL }      from '../config.js';

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

async function getTournamentMap(env, tour) {
    const ckey = ['tournament-map-v5', tour];
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

// ── Route handler ──────────────────────────────────────────────────────────────

export async function handleH2H(request, env) {
    const { searchParams } = new URL(request.url);
    const playerKeyA = searchParams.get('playerKeyA');
    const playerKeyB = searchParams.get('playerKeyB');
    const tour       = (searchParams.get('tour') || 'ATP').toUpperCase();

    if (!playerKeyA || !playerKeyB) throw new Error('playerKeyA and playerKeyB are required');

    // Cache key preserves A→B order so p1/p2 orientation is always consistent.
    // Querying B→A fills a separate entry with correctly flipped orientation.
    const cacheArgs = ['h2h-v9', tour, playerKeyA, playerKeyB];

    const cached = await cache.get(env, ...cacheArgs);
    if (cached) return cached.data;

    const pIdA = Number(playerKeyA);
    const pIdB = Number(playerKeyB);

    try {
        const [pastResult, surfaceResult, mapResult] = await Promise.allSettled([
            rapidAPI.playerPastMatches(env, tour, playerKeyA, 200),
            rapidAPI.h2h(env, tour, playerKeyA, playerKeyB),
            getTournamentMap(env, tour),
        ]);

        const allMatches  = pastResult.status  === 'fulfilled' ? (pastResult.value?.data  || []) : [];
        const surfaceData = surfaceResult.status === 'fulfilled' ? (surfaceResult.value?.data || []) : [];
        const tMap        = mapResult.status    === 'fulfilled' ?  mapResult.value            : {};

        // Debug: log first raw match to see field structure
        if (allMatches.length > 0) {
            console.log('[h2h] first raw match keys:', JSON.stringify(Object.keys(allMatches[0])));
            console.log('[h2h] first raw match:', JSON.stringify(allMatches[0]));
        }

        // Filter to H2H matches only, then transform
        const h2hMatches = allMatches
            .filter(m =>
                (m.player1Id === pIdA && m.player2Id === pIdB) ||
                (m.player1Id === pIdB && m.player2Id === pIdA)
            )
            .map(m => transformMatch(m, tMap));

        const data = {
            h2hMatches,
            surfaceSplits: transformSurface(surfaceData),
            _rawSample: allMatches.slice(0, 2),
        };

        await cache.set(env, TTL.h2h, data, ...cacheArgs);
        return data;

    } catch (err) {
        const stale = await cache.getStale(env, ...cacheArgs);
        if (stale) return stale.data;
        throw err;
    }
}
