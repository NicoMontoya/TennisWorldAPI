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
// Live endpoints (get_livescore) use a circuit breaker: if they fail repeatedly,
// the caller gets an empty result rather than cascading errors.
//
// Alternative data sources (swap in here when needed):
//   SportRadar:       https://developer.sportradar.com/tennis/reference
//   Ultimate Tennis:  https://rapidapi.com/api-tennis/api/tennis-live-data
//   OpenLigaDB:       community-maintained, free

import { getMock } from './mocks/index.js';

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
    const res = await fetch(url, {
        headers: {
            'X-RapidAPI-Key':  env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPID_HOST,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
    });
    if (res.status === 429 && attempt <= 3) {
        await sleep(BASE_DELAY * 2 ** attempt);
        return rapidFetch(env, path, attempt + 1);
    }
    if (!res.ok) throw new Error(`RapidAPI ${res.status}: ${path}`);
    const json = await res.json();
    if (json.error) throw new Error(`RapidAPI error: ${json.message}`);
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

    // Full tournament calendar for a year — use pageSize=200 to get all at once
    // Each entry: { id, name, courtId, date, rankId, draw_size, tier, court, coutry }
    calendar: (env, tour, year) =>
        rapidFetch(env, `/${tour.toLowerCase()}/tournament/calendar/${year}?pageSize=2000`),

    // Singles rankings: { data: [{position, point, player: {id, name, currentRank, ...}}] }
    // pageSize=100 for enrichment lookups; pass 2000 to get all ranked players (multi-week).
    rankings: (env, tour, pageSize = 100) =>
        rapidFetch(env, `/${tour.toLowerCase()}/ranking/singles?pageSize=${pageSize}`),

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
    // { data: [{id, date, match_winner, result, player1Id, player2Id, ...}] }
    playerPastMatches: (env, tour, playerId, pageSize = 30) =>
        rapidFetch(env, `/${tour.toLowerCase()}/player/past-matches/${playerId}?pageSize=${pageSize}`),

    // Career titles by tier: { data: [{tourRankId, tourRank, titlesWon, titlesLost}] }
    // tourRankId >= 2 = main tour + masters + grand slams
    playerTitles: (env, tour, playerId) =>
        rapidFetch(env, `/${tour.toLowerCase()}/player/titles/${playerId}`),
};

// ── Public API ─────────────────────────────────────────────────────────────────

export const apiTennis = {
    standings:   (env, eventType)    => call(env, 'get_standings',   { event_type: eventType }),
    tournaments: (env, eventTypeKey) => call(env, 'get_tournaments', { event_type_key: eventTypeKey }),
    // livescore uses circuit breaker — an outage here must not break the hub
    livescore:   (env, opts = {})    => call(env, 'get_livescore',   opts,          { circuitBreaker: true }),
    fixtures:    (env, opts = {})    => call(env, 'get_fixtures',    opts),
    player:      (env, playerKey)    => call(env, 'get_players',     { player_key: playerKey }),
    h2h:         (env, keyA, keyB)   => call(env, 'get_H2H',         { first_player_key: keyA, second_player_key: keyB }),
};
