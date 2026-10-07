import { cache } from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { parseTour, rateLimit } from '../security.js';

// GET /api/player-history?tour=ATP|WTA&playerKey=47275
//
// Returns year-by-year match stats built from the player's last 500 matches.
// Used by the player profile page for the Season Performance chart and career table.
//
// Season shape:
//   { year, wins, losses, winPct, titles, hard:{wins,losses}, clay:{wins,losses}, grass:{wins,losses} }
//
// Caching: 12h — changes only after a match is played. Empty seasons are not
// written to KV. No matches, or a thrown upstream error, is an edge-only miss:
// 10 min for an empty list, a 4xx, or an error body; 2 min for a 5xx, 429,
// timeout, or unknown status.
// Tour and playerKey are checked before any cache read or upstream call.
// playerKey is 1–10 digits. Rate limit bucket: player-history (fail closed).

const TTL_HISTORY  = 12 * 60 * 60;
const TTL_TITLES   = 72 * 60 * 60;
const TTL_CALENDAR = 24 * 60 * 60;
const TTL_MISS          = 10 * 60;
const TTL_UPSTREAM_MISS =  2 * 60;

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
    await rateLimit(env, request, 'player-history');

    const { searchParams } = new URL(request.url);
    const tour      = parseTour(searchParams.get('tour'));
    const playerKey = parsePlayerKey(searchParams.get('playerKey'));

    const miss = await cache.getEdge('player-history-miss', tour, playerKey);
    if (miss?.data?.miss === true) return { seasons: [], careerTitles: 0 };

    const cacheKey = ['player-history-v1', tour, playerKey];
    const cached   = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    const pid = Number(playerKey);

    // Matches decide whether this key is a player. An empty list is not a KV
    // write, and the shared tournament map is not fetched for that miss.
    let matches = [];
    let upstreamEmpty = false;
    try {
        const raw = await rapidAPI.playerPastMatches(env, tour, playerKey, 500);
        matches = raw?.data || [];
        if (!matches.length) upstreamEmpty = true;
    } catch (e) {
        console.error(`[player-history] past-matches failed for ${tour}/${playerKey}:`, e.message);
        await cache.setEdge(upstreamMissTtl(e), { miss: true }, 'player-history-miss', tour, playerKey);
        return { seasons: [], careerTitles: 0 };
    }

    if (!matches.length) {
        if (upstreamEmpty) {
            await cache.setEdge(TTL_MISS, { miss: true }, 'player-history-miss', tour, playerKey);
        }
        return { seasons: [], careerTitles: 0 };
    }

    const [tMapResult, titlesResult] = await Promise.allSettled([
        getTournamentMap(env, tour),
        rapidAPI.playerTitles(env, tour, playerKey),
    ]);

    const tMap      = tMapResult.status    === 'fulfilled' ?  tMapResult.value           : {};
    const titlesRaw = titlesResult.status  === 'fulfilled' ? (titlesResult.value?.data || []) : [];

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
