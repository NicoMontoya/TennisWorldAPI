import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';

// GET /api/player-stats?tour=ATP|WTA&playerKey=47275
//
// Returns { titles, form, wins, losses, winPct, surface, birthday } for one player.
// surface = { hard: {wins, losses}, clay: {wins, losses}, grass: {wins, losses} }
// birthday comes from the player profile — the standings list omits it, so the
// rankings page enriches its Age column from here.
//
// Caching:
//   titles         → 72h  (changes only after a title win)
//   past-matches   → 6h   (updates after each match)
//   tournament-map → 24h  (shared cache key with h2h.js)
//   profile        → 30d  (birthday never changes)

const TTL_TITLES   = 72 * 60 * 60;
const TTL_MATCHES  =  6 * 60 * 60;
const TTL_CALENDAR = 24 * 60 * 60;
const TTL_PROFILE  = 30 * 24 * 60 * 60;

const MAIN_TOUR_RANK_ID = 2;

function normSurface(court) {
    if (!court) return 'hard';
    const c = court.toLowerCase();
    if (c.includes('clay'))  return 'clay';
    if (c.includes('grass')) return 'grass';
    return 'hard';
}

// Reuses the same cache key as h2h.js so both routes share one warm cache entry.
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
            if (t.id) map[t.id] = { name: t.name || '', surface: normSurface(t.court?.name) };
        }
    }

    await cache.set(env, TTL_CALENDAR, map, ...ckey);
    return map;
}

export async function handlePlayerStats(request, env) {
    const { searchParams } = new URL(request.url);
    const tour      = (searchParams.get('tour') || 'ATP').toUpperCase();
    const playerKey = searchParams.get('playerKey');
    if (!playerKey) throw new Error('playerKey is required');

    const pid = Number(playerKey);

    // ── Titles ────────────────────────────────────────────────────────────────
    const titlesCacheKey = ['player-titles', tour, playerKey];
    let titles = 0;

    const cachedTitles = await cache.get(env, ...titlesCacheKey);
    if (cachedTitles) {
        titles = cachedTitles.data;
    } else {
        try {
            const raw = await rapidAPI.playerTitles(env, tour, playerKey);
            titles = (raw?.data || [])
                .filter(t => (t.tourRankId ?? 99) >= MAIN_TOUR_RANK_ID)
                .reduce((sum, t) => sum + (Number(t.titlesWon) || 0), 0);
            await cache.set(env, TTL_TITLES, titles, ...titlesCacheKey);
        } catch (e) {
            console.error(`[player-stats] titles failed for ${tour}/${playerKey}:`, e.message);
        }
    }

    // ── Past matches (200 for surface coverage) ───────────────────────────────
    const matchesCacheKey = ['player-past-matches-200', tour, playerKey];
    let matches = [];

    const cachedMatches = await cache.get(env, ...matchesCacheKey);
    if (cachedMatches) {
        matches = cachedMatches.data;
    } else {
        try {
            const raw = await rapidAPI.playerPastMatches(env, tour, playerKey, 200);
            matches = raw?.data || [];
            await cache.set(env, TTL_MATCHES, matches, ...matchesCacheKey);
        } catch (e) {
            console.error(`[player-stats] past-matches failed for ${tour}/${playerKey}:`, e.message);
        }
    }

    // ── Profile (birthday) ────────────────────────────────────────────────────
    const profileCacheKey = ['player-profile', tour, playerKey];
    let birthday = null;

    const cachedProfile = await cache.get(env, ...profileCacheKey);
    if (cachedProfile) {
        birthday = cachedProfile.data;
    } else {
        try {
            const raw = await rapidAPI.playerProfile(env, tour, playerKey);
            birthday = raw?.data?.birthday || null;
            if (birthday) await cache.set(env, TTL_PROFILE, birthday, ...profileCacheKey);
        } catch (e) {
            console.error(`[player-stats] profile failed for ${tour}/${playerKey}:`, e.message);
        }
    }

    // ── Tournament map for surface lookup ─────────────────────────────────────
    let tMap = {};
    try {
        tMap = await getTournamentMap(env, tour);
    } catch (e) {
        console.error(`[player-stats] tournament-map failed:`, e.message);
    }

    // ── Form (last 10) ────────────────────────────────────────────────────────
    const form = matches.slice(0, 10).map(m => {
        const w = m.match_winner;
        return (w === pid || String(w) === playerKey) ? 'W' : 'L';
    });

    // ── Season stats (current year) ───────────────────────────────────────────
    const currentYear = new Date().getFullYear();
    const seasonMatches = matches.filter(m =>
        m.date && new Date(m.date).getFullYear() === currentYear
    );
    const wins   = seasonMatches.filter(m => {
        const w = m.match_winner;
        return w === pid || String(w) === playerKey;
    }).length;
    const losses = seasonMatches.length - wins;
    const winPct = seasonMatches.length > 0
        ? Math.round((wins / seasonMatches.length) * 100)
        : null;

    // ── Career surface splits ─────────────────────────────────────────────────
    const surface = { hard: { wins: 0, losses: 0 }, clay: { wins: 0, losses: 0 }, grass: { wins: 0, losses: 0 } };

    for (const m of matches) {
        const tId    = m.tournamentId ?? m.tournament?.id;
        const tInfo  = tId != null ? tMap[tId] : null;
        const surf   = tInfo?.surface || normSurface(m.tournament?.court?.name);
        const bucket = surface[surf] ?? surface.hard;
        const won    = m.match_winner === pid || String(m.match_winner) === playerKey;
        if (won) bucket.wins++; else bucket.losses++;
    }

    return { titles, form, wins, losses, winPct, surface, birthday };
}
