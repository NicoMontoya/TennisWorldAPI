// ===================================
// API-Tennis.com Client
// ===================================
// Single place that knows how to talk to the upstream API.
// All routes go through here — never fetch upstream directly from a route.
//
// DEMO_MODE: when env.DEMO_MODE === "true" (or no API key is set),
// every call returns mock data from src/mocks/ instead of hitting the network.
// This lets the site run fully offline for development or demos.
//
// Resilience: automatic retry with exponential backoff (3 attempts by default).
// Scores live uses MatchStat Extend `/extend/api/events/live` with the existing
// Worker secret RAPIDAPI_KEY (same key/host as Core). TENNIS_API_KEY is not
// used on the livescore path. Upstream errors are generic — never json.message
// or the secret.
//
// Alternative data sources (swap in here when needed):
//   SportRadar:       https://developer.sportradar.com/tennis/reference
//   Ultimate Tennis:  https://rapidapi.com/api-tennis/api/tennis-live-data
//   OpenLigaDB:       community-maintained, free

import { getMock } from './mocks/index.js';
import { unwrapLiveEvents } from './transforms/matchstatLive.js';

const BASE         = 'https://api.api-tennis.com/tennis/';
const MAX_RETRIES  = 3;
const BASE_DELAY   = 300; // ms — doubles each attempt

// ── Circuit breaker state ──────────────────────────────────────────────────────
// Shared across requests within the same Worker isolate lifetime.
const circuitBreaker = {
    failures:    0,
    openUntil:   0,     // epoch ms
    THRESHOLD:   5,     // trips after this many failures
    RESET_MS:    60_000 // 1 minute cool-down
};

function isCircuitOpen() {
    if (circuitBreaker.failures >= circuitBreaker.THRESHOLD) {
        if (Date.now() < circuitBreaker.openUntil) return true;
        // Cool-down passed — reset
        circuitBreaker.failures  = 0;
        circuitBreaker.openUntil = 0;
    }
    return false;
}

function recordFailure() {
    circuitBreaker.failures++;
    circuitBreaker.openUntil = Date.now() + circuitBreaker.RESET_MS;
}

function recordSuccess() {
    circuitBreaker.failures = 0;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isDemoMode(env) {
    return env.DEMO_MODE === 'true' || !env.TENNIS_API_KEY;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Core fetch with retry ──────────────────────────────────────────────────────

async function fetchWithRetry(urlStr, attempt = 1) {
    try {
        const res = await fetch(urlStr);
        if (!res.ok) {
            // 429 Too Many Requests — always retry with longer delay
            if (res.status === 429 && attempt <= MAX_RETRIES) {
                await sleep(BASE_DELAY * 2 ** attempt);
                return fetchWithRetry(urlStr, attempt + 1);
            }
            throw new Error(`API-Tennis error: ${res.status} ${res.statusText}`);
        }
        return res;
    } catch (err) {
        if (attempt < MAX_RETRIES) {
            await sleep(BASE_DELAY * 2 ** attempt);
            return fetchWithRetry(urlStr, attempt + 1);
        }
        throw err;
    }
}

// ── Public call function ───────────────────────────────────────────────────────

async function call(env, method, params = {}, opts = {}) {
    // ── Demo / offline mode ───────────────────────────────────────────────────
    if (isDemoMode(env)) {
        return getMock(method, params);
    }

    // ── Circuit breaker (live endpoints only) ─────────────────────────────────
    if (opts.circuitBreaker && isCircuitOpen()) {
        return [];   // return empty rather than hammering a broken API
    }

    // ── Build URL ─────────────────────────────────────────────────────────────
    const url = new URL(BASE);
    url.searchParams.set('method', method);
    url.searchParams.set('APIkey', env.TENNIS_API_KEY);

    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    // ── Fetch with retry ──────────────────────────────────────────────────────
    let res;
    try {
        res = await fetchWithRetry(url.toString());
    } catch (err) {
        recordFailure();
        throw err;
    }

    const json = await res.json();

    // API-Tennis wraps results in { result: [...] }
    // result can be false/null when no data exists (e.g. no live matches)
    if (json.result === undefined) {
        recordFailure();
        throw new Error(`API-Tennis: unexpected response shape`);
    }

    recordSuccess();
    return json.result || [];
}

// ── RapidAPI (tennis-api-atp-wta-itf) ─────────────────────────────────────────
// New API — cleaner REST paths, real seeds, full match history.
// Base: https://tennis-api-atp-wta-itf.p.rapidapi.com/tennis/v2/{tour}/...

const RAPID_BASE = 'https://tennis-api-atp-wta-itf.p.rapidapi.com/tennis/v2';
const RAPID_HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';

async function rapidFetch(env, path, attempt = 1) {
    const url = `${RAPID_BASE}${path}`;
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(10_000)
        : undefined;
    let res;
    try {
        res = await fetch(url, {
            headers: {
                'X-RapidAPI-Key':  env.RAPIDAPI_KEY,
                'X-RapidAPI-Host': RAPID_HOST,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            },
            signal,
        });
    } catch {
        throw new Error('Upstream request failed');
    }
    if (res.status === 429 && attempt <= 3) {
        await sleep(BASE_DELAY * 2 ** attempt);
        return rapidFetch(env, path, attempt + 1);
    }
    // Generic errors only — never path, json.message, or the secret.
    if (!res.ok) throw new Error('Upstream request failed');
    const json = await res.json();
    if (json.error) throw new Error('Upstream request failed');
    return json;
}

export const rapidAPI = {
    // Tournament results (completed matches): data.singles[], data.doubles[]
    // Each match: { id, date, roundId, player1Id, player2Id, match_winner, result, player1, player2 }
    tournamentResults: (env, tour, tournamentId) =>
        rapidFetch(env, `/${tour.toLowerCase()}/tournament/results/${tournamentId}?pageSize=500`),

    // Remaining fixtures (upcoming matches, includes seeds):
    // { data: [{id, roundId, seed1, seed2, player1, player2, ...}], hasNextPage }
    tournamentFixtures: (env, tour, tournamentId) =>
        rapidFetch(env, `/${tour.toLowerCase()}/fixtures/tournament/${tournamentId}?pageSize=200`),

    // Full tournament calendar for a year — paginated. A requested pageSize=500
    // is accepted but silently capped upstream at ~201 rows/page (same behavior
    // documented on rankingsPaged below), and a season has ~700-1000 events, so
    // we page through with pageNo until an empty page. Returns the same
    // { data: [...] } shape as a single call so callers are unchanged.
    // Each entry: { id, name, courtId, date, rankId, draw_size, tier, court, coutry }
    calendar: async (env, tour, year) => {
        const all = [];
        // NB: `hasNextPage` is unreliable (null even when more pages exist), and a
        // "short page" is NOT a reliable end-of-data signal — every page comes
        // back at the ~201 cap regardless of the requested pageSize, so a
        // `page.length < 500` check broke after page 1 every time, silently
        // truncating each year to ~201 of ~900 tournaments (losing most Grand
        // Slams/Masters — the events title-tier detection depends on). Terminate
        // on a genuinely empty page instead. Pages aren't date-ordered; callers
        // filter as needed.
        for (let pageNo = 1; pageNo <= 8; pageNo++) {
            const json = await rapidFetch(env, `/${tour.toLowerCase()}/tournament/calendar/${year}?pageSize=500&pageNo=${pageNo}`);
            const page = json?.data || [];
            if (!page.length) break;
            all.push(...page);
            // A full year now takes ~5 pages (was 1 before the pagination fix
            // above) — space them out so a caller fetching many years at once
            // (getTierMap) doesn't burst RapidAPI's rate limit across pages.
            if (pageNo < 8) await sleep(150);
        }
        return { data: all };
    },

    // Singles rankings: { data: [{position, point, player: {id, name, currentRank, ...}}] }
    // pageSize=100 for enrichment lookups; pass 2000 to get all ranked players (multi-week).
    rankings: (env, tour, pageSize = 100) =>
        rapidFetch(env, `/${tour.toLowerCase()}/ranking/singles?pageSize=${pageSize}`),

    // Full rankings via pageNo pagination. The endpoint caps a single page at ~201
    // rows regardless of pageSize, so `rankings(…, 2000)` only ever returns the top
    // ~201 — leaving live players ranked deeper (e.g. draw qualifiers) with no rank
    // or country. This pages until an empty/short page or maxPages, deduping by
    // position, to reach ~2000. Returns the same { data: [...] } shape as rankings().
    rankingsPaged: async (env, tour, { pageSize = 200, maxPages = 10 } = {}) => {
        const byPos = new Map();
        for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
            let json;
            try {
                json = await rapidFetch(env, `/${tour.toLowerCase()}/ranking/singles?pageSize=${pageSize}&pageNo=${pageNo}`);
            } catch { break; }
            const items = json?.data || [];
            if (!items.length) break;
            const before = byPos.size;
            for (const it of items) if (it.position != null) byPos.set(it.position, it);
            if (byPos.size === before) break; // no new positions → past the end
        }
        return { data: [...byPos.values()] };
    },

    // Historical snapshot for a specific date. Returns the same shape as rankings().
    // filter=RankingDate:YYYY-MM-DD returns the snapshot on or before that date.
    rankingsAtDate: (env, tour, date, pageSize = 200) =>
        rapidFetch(env, `/${tour.toLowerCase()}/ranking/singles?pageSize=${pageSize}&filter=RankingDate:${date}`),

    // Tournament info: { data: { id, name, courtId, date, tier, court, ... } }
    tournamentInfo: (env, tour, tournamentId) =>
        rapidFetch(env, `/${tour.toLowerCase()}/tournament/info/${tournamentId}`),

    // H2H info — wins per surface: { data: [{court, player1wins, player2wins}] }
    h2h: (env, tour, p1Id, p2Id) =>
        rapidFetch(env, `/${tour.toLowerCase()}/h2h/info/${p1Id}/${p2Id}`),

    // Last N completed matches for a player, most recent first
    // { data: [{id, date, match_winner, result, player1Id, player2Id, ...}], hasNextPage }
    // pageNo drives pagination (the `page` param is silently ignored upstream).
    // Defaults to 1 so existing 3/4-arg callers keep getting the first page unchanged.
    playerPastMatches: (env, tour, playerId, pageSize = 30, pageNo = 1) =>
        rapidFetch(env, `/${tour.toLowerCase()}/player/past-matches/${playerId}?pageSize=${pageSize}&pageNo=${pageNo}`),

    // Career titles by tier: { data: [{tourRankId, tourRank, titlesWon, titlesLost}] }
    // tourRankId >= 2 = main tour + masters + grand slams
    playerTitles: (env, tour, playerId) =>
        rapidFetch(env, `/${tour.toLowerCase()}/player/titles/${playerId}`),

    // Player profile: { data: { id, name, birthday, countryAcr, currentRank, country, information } }
    // birthday is ISO ("2001-08-16T00:00:00.000Z"); may be absent for lesser-known players.
    playerProfile: (env, tour, playerId) =>
        rapidFetch(env, `/${tour.toLowerCase()}/player/profile/${playerId}`),

    // Extend live board — same RAPIDAPI_KEY / host as Core, different path prefix.
    // GET /tennis/v2/extend/api/events/live
    // Envelope is { success, results: [...], count } (also result/data aliases).
    // Returns a list (unwrapped). Each item: { id, matchId, tourType, status, score, points, ... }
    // `id` is the live-event namespace and must never be used as Scores matchKey.
    liveEvents: async (env) => {
        // Worker secret only. Missing key → empty board, no throw / no log.
        if (!env?.RAPIDAPI_KEY) return [];
        const json = await rapidFetch(env, '/extend/api/events/live');
        return unwrapLiveEvents(json);
    },

    // Optional per-event live score. eventId is the Extend live id (digits only).
    liveScoreByEventId: async (env, eventId) => {
        const id = String(eventId ?? '');
        if (!/^\d{1,20}$/.test(id)) throw new Error('Invalid live event id');
        if (!env?.RAPIDAPI_KEY) return null;
        return rapidFetch(env, `/extend/api/event/live-score/get/${id}`);
    },
};

// ── Public API ─────────────────────────────────────────────────────────────────

export const apiTennis = {
    standings:   (env, eventType)    => call(env, 'get_standings',   { event_type: eventType }),
    tournaments: (env, eventTypeKey) => call(env, 'get_tournaments', { event_type_key: eventTypeKey }),
    // get_livescore removed — Scores live is MatchStat-only (RAPIDAPI_KEY).
    // Remaining methods still use TENNIS_API_KEY (fixtures / tournaments / H2H).
    fixtures:    (env, opts = {})    => call(env, 'get_fixtures',    opts),
    player:      (env, playerKey)    => call(env, 'get_players',     { player_key: playerKey }),
    h2h:         (env, keyA, keyB)   => call(env, 'get_H2H',         { first_player_key: keyA, second_player_key: keyB }),
};
