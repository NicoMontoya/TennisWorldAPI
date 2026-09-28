import { cache } from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { parseTour, rateLimit } from '../security.js';

// GET /api/player-stats?tour=ATP|WTA&playerKey=47275
//
// Returns { titles, form, wins, losses, winPct, surface, birthday } for one player.
// surface = { hard: {wins, losses}, clay: {wins, losses}, grass: {wins, losses} }
// birthday comes from the player profile — the standings list omits it, so the
// rankings page enriches its Age column from here.
//
// Caching (unchanged TTLs, only after the player exists):
//   titles         → 72h  (changes only after a title win; 0 is cached for a real player)
//   past-matches   → 6h   (updates after each match; never an empty list)
//   tournament-map → 24h  (shared cache key with h2h.js)
//   profile        → 30d  (birthday never changes)
// A lookup with no past matches, or a thrown upstream error, is an edge-only
// miss (no KV write): 10 min for an empty list, a 4xx, or an error body; 2 min
// for a 5xx, 429, timeout, or unknown status.
// Tour and playerKey are checked before any cache read or upstream call.
// playerKey is 1–10 digits. Rate limit bucket: player-stats (fail closed).

const TTL_TITLES   = 72 * 60 * 60;
const TTL_MATCHES  =  6 * 60 * 60;
const TTL_CALENDAR = 24 * 60 * 60;
const TTL_PROFILE  = 30 * 24 * 60 * 60;
const TTL_MISS     = 10 * 60;
const TTL_UPSTREAM_MISS = 2 * 60;

const MAIN_TOUR_RANK_ID = 2;
const PLAYER_KEY_RE = /^\d{1,10}$/;

function httpError(status, message) {
    throw Object.assign(new Error(message), { status });
}

function parsePlayerKey(raw) {
    if (raw == null || String(raw).trim() === '') httpError(400, 'playerKey is required');
    const playerKey = String(raw).trim();
    if (!PLAYER_KEY_RE.test(playerKey)) httpError(400, 'Invalid playerKey.');
    return playerKey;
}

// 4xx (not 429) and an error body (2xx) stay for 10 minutes. 5xx, 429, a timeout,
// and any status we cannot read are 2 minutes so a blip can recover.
function upstreamMissTtl(err) {
    const status = Number(err?.status);
    if (!Number.isInteger(status)) return TTL_UPSTREAM_MISS;
    if (status === 429 || status >= 500) return TTL_UPSTREAM_MISS;
    if ((status >= 400 && status < 500) || (status >= 200 && status < 300)) return TTL_MISS;
    return TTL_UPSTREAM_MISS;
}

function emptyStats() {
    return {
        titles: 0,
        form: [],
        wins: 0,
        losses: 0,
        winPct: null,
        surface: {
            hard:  { wins: 0, losses: 0 },
            clay:  { wins: 0, losses: 0 },
            grass: { wins: 0, losses: 0 },
        },
        birthday: null,
    };
}

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
    await rateLimit(env, request, 'player-stats');

    const { searchParams } = new URL(request.url);
    const tour      = parseTour(searchParams.get('tour'));
    const playerKey = parsePlayerKey(searchParams.get('playerKey'));

    const miss = await cache.getEdge('player-stats-miss', tour, playerKey);
    if (miss?.data?.miss === true) return emptyStats();

    const pid = Number(playerKey);

    // ── Past matches (200 for surface coverage) ───────────────────────────────
    // Existence is "has matches". An empty list is not written to KV. Titles and
    // profile run only after that, so a made-up key cannot mint those entries.
    const matchesCacheKey = ['player-past-matches-200', tour, playerKey];
    let matches = [];
    let upstreamEmpty = false;

    const cachedMatches = await cache.get(env, ...matchesCacheKey);
    if (Array.isArray(cachedMatches?.data)) {
        matches = cachedMatches.data;
        if (!matches.length) upstreamEmpty = true;
    } else {
        try {
            const raw = await rapidAPI.playerPastMatches(env, tour, playerKey, 200);
            matches = raw?.data || [];
            if (matches.length) {
                await cache.set(env, TTL_MATCHES, matches, ...matchesCacheKey);
            } else {
                upstreamEmpty = true;
            }
        } catch (e) {
            console.error(`[player-stats] past-matches failed for ${tour}/${playerKey}:`, e.message);
            await cache.setEdge(upstreamMissTtl(e), { miss: true }, 'player-stats-miss', tour, playerKey);
            return emptyStats();
        }
    }

    if (!matches.length) {
        if (upstreamEmpty) {
            await cache.setEdge(TTL_MISS, { miss: true }, 'player-stats-miss', tour, playerKey);
        }
        return emptyStats();
    }

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
