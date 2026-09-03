import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';

// GET /api/player-history?tour=ATP|WTA&playerKey=47275
//
// Returns year-by-year match stats built from the player's last 500 matches.
// Used by the player profile page for the Season Performance chart and career table.
//
// Season shape:
//   { year, wins, losses, winPct, titles, hard:{wins,losses}, clay:{wins,losses}, grass:{wins,losses} }
//
// Caching: 12h — changes only after a match is played.

const TTL_HISTORY  = 12 * 60 * 60;
const TTL_TITLES   = 72 * 60 * 60;
const TTL_CALENDAR = 24 * 60 * 60;

const MAIN_TOUR_RANK_ID = 2;

function normSurface(court) {
    if (!court) return 'hard';
    const c = court.toLowerCase();
    if (c.includes('clay'))  return 'clay';
    if (c.includes('grass')) return 'grass';
    return 'hard';
}

// Shared cache key with h2h.js and playerStats.js — one warm entry for all routes.
// v6: bumped after fixing calendar() pagination (was truncating to ~201 of
// ~900 tournaments/year, dropping most Slams/Masters from the map).
async function getTournamentMap(env, tour) {
    const ckey = ['tournament-map-v6', tour];
    const cached = await cache.get(env, ...ckey);
    if (cached) return cached.data;

    const year  = new Date().getFullYear();
    const years = [year, year - 1, year - 2, year - 3, year - 4];

    const results = await Promise.allSettled(
        years.map(y => rapidAPI.calendar(env, tour, y))
    );

    const map = {};
    for (const res of results) {
        if (res.status !== 'fulfilled') continue;
        for (const t of (res.value?.data || [])) {
            if (t.id) map[t.id] = {
                name:      t.name  || '',
                surface:   normSurface(t.court?.name),
                rankId:    t.rankId ?? null,
            };
        }
    }

    await cache.set(env, TTL_CALENDAR, map, ...ckey);
    return map;
}

export async function handlePlayerHistory(request, env) {
    const { searchParams } = new URL(request.url);
    const tour      = (searchParams.get('tour') || 'ATP').toUpperCase();
    const playerKey = searchParams.get('playerKey');
    if (!playerKey) throw new Error('playerKey is required');

    const cacheKey = ['player-history-v1', tour, playerKey];
    const cached   = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    const pid = Number(playerKey);

    // ── Fetch matches + tournament map in parallel ─────────────────────────────
    const [matchesResult, tMapResult, titlesResult] = await Promise.allSettled([
        rapidAPI.playerPastMatches(env, tour, playerKey, 500),
        getTournamentMap(env, tour),
        rapidAPI.playerTitles(env, tour, playerKey),
    ]);

    const matches = matchesResult.status  === 'fulfilled' ? (matchesResult.value?.data  || []) : [];
    const tMap    = tMapResult.status     === 'fulfilled' ?  tMapResult.value              : {};
    const titlesRaw = titlesResult.status === 'fulfilled' ? (titlesResult.value?.data || []) : [];

    // Career total titles (no per-year breakdown from this endpoint)
    const careerTitles = titlesRaw
        .filter(t => (t.tourRankId ?? 99) >= MAIN_TOUR_RANK_ID)
        .reduce((sum, t) => sum + (Number(t.titlesWon) || 0), 0);

    // ── Group matches by year ─────────────────────────────────────────────────
    const byYear = {};

    for (const m of matches) {
        if (!m.date) continue;
        const year = new Date(m.date).getFullYear();

        if (!byYear[year]) {
            byYear[year] = {
                year,
                wins: 0, losses: 0,
                titles: 0,
                hard:  { wins: 0, losses: 0 },
                clay:  { wins: 0, losses: 0 },
                grass: { wins: 0, losses: 0 },
            };
        }

        const s    = byYear[year];
        const won  = m.match_winner === pid || String(m.match_winner) === playerKey;
        const tId  = m.tournamentId ?? m.tournament?.id;
        const tInfo = tId != null ? tMap[tId] : null;
        const surf  = tInfo?.surface || normSurface(m.tournament?.court?.name);
        const bucket = s[surf] ?? s.hard;

        if (won) { s.wins++; bucket.wins++; } else { s.losses++; bucket.losses++; }

        // Count titles: won a Final (roundId 12) in a main-tour+ tournament
        const rankId = tInfo?.rankId ?? null;
        if (won && m.roundId === 12 && (rankId === null || rankId >= MAIN_TOUR_RANK_ID)) {
            s.titles++;
        }
    }

    // ── Build sorted seasons array (most-recent first) ────────────────────────
    const seasons = Object.values(byYear)
        .map(s => ({
            ...s,
            winPct: (s.wins + s.losses) > 0
                ? Math.round((s.wins / (s.wins + s.losses)) * 100)
                : null,
        }))
        .sort((a, b) => b.year - a.year);

    const data = { seasons, careerTitles };

    if (seasons.length) {
        await cache.set(env, TTL_HISTORY, data, ...cacheKey);
    }

    return data;
}
