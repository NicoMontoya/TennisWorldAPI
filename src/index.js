// ===================================
// TennisWorld API — Cloudflare Worker
// ===================================
// Entry point. Handles routing, CORS, and error formatting.
// All business logic lives in src/routes/*.

import { handleStandings }        from './routes/standings.js';
import { handlePlayerStats }      from './routes/playerStats.js';
import { handleLivescore }        from './routes/livescore.js';
import { handleFixtures }         from './routes/fixtures.js';
import { handlePlayer }           from './routes/players.js';
import { handleH2H }              from './routes/h2h.js';
import { handleTournaments }      from './routes/tournaments.js';
import { handleSurfaceStandings } from './routes/surfaceStandings.js';
import { handleHub }              from './routes/hub.js';
import { handleDraws }            from './routes/draws.js';
import { handleCalendar }         from './routes/calendar.js';
import { handlePlayerHistory }     from './routes/playerHistory.js';
import { handleVintageRoster, handlePlayerVintage, handleImportVintage } from './routes/vintage.js';
import { handleVintageRankByAge, handleImportVintageRankByAge } from './routes/vintageRankByAge.js';
import { handlePlayerRankHistory, seedRankSnapshots } from './routes/playerRankHistory.js';
import { getCalendarYear } from './calendarYear.js';
import { handleBackfillRankings, handleClearRankHistory, handleImportRankHistory, handleImportMatches } from './routes/adminBackfill.js';
import { handleImportOfficialDraw } from './routes/officialDrawAdmin.js';
import { handleRankingsHistory, handleImportRankingsHistory } from './routes/rankingsHistory.js';
import { handleRegister, handleLogin, handleLogout, handleMe, handleUpdateProfile, handleChangePassword } from './routes/auth.js';
import { handleFavorites, handleFavoritesToggle }              from './routes/favorites.js';
import { handlePredict }      from './routes/predict.js';
import { handleBracketSave, handleBracketMine, handleBracketLeaders, handleBracketPublic } from './routes/userBrackets.js';

// ── Route table (GET) ─────────────────────────────────────────────────────────
const GET_ROUTES = {
    '/api/standings':         handleStandings,
    '/api/player-stats':      handlePlayerStats,
    '/api/livescore':         handleLivescore,
    '/api/fixtures':          handleFixtures,
    '/api/players':           handlePlayer,
    '/api/h2h':               handleH2H,
    '/api/tournaments':       handleTournaments,
    '/api/surface-standings': handleSurfaceStandings,
    '/api/hub':               handleHub,
    '/api/draws':             handleDraws,
    '/api/predict':           handlePredict,
    '/api/calendar':          handleCalendar,
    '/api/player-history':         handlePlayerHistory,
    '/api/vintage-roster':         handleVintageRoster,
    '/api/player-vintage':         handlePlayerVintage,
    '/api/vintage-rank-by-age':    handleVintageRankByAge,
    '/api/player-ranking-history':      handlePlayerRankHistory,
    '/api/rankings-history':            handleRankingsHistory,
    '/api/admin/backfill-rankings':     handleBackfillRankings,
    '/api/admin/clear-rank-history':    handleClearRankHistory,
    '/api/auth/me':           handleMe,
    '/api/favorites':         handleFavorites,
    '/api/bracket/mine':      handleBracketMine,
    '/api/bracket/leaders':   handleBracketLeaders,
    '/api/bracket/public':    handleBracketPublic,
};

// ── Route table (POST) ────────────────────────────────────────────────────────
const POST_ROUTES = {
    '/api/auth/register':         handleRegister,
    '/api/auth/login':            handleLogin,
    '/api/auth/logout':           handleLogout,
    '/api/auth/update-profile':   handleUpdateProfile,
    '/api/auth/change-password':  handleChangePassword,
    '/api/favorites/toggle':          handleFavoritesToggle,
    '/api/bracket/save':              handleBracketSave,
    '/api/admin/import-rank-history': handleImportRankHistory,
    '/api/admin/import-rankings-history': handleImportRankingsHistory,
    '/api/admin/import-vintage':          handleImportVintage,
    '/api/admin/import-vintage-rank-by-age': handleImportVintageRankByAge,
    '/api/admin/import-matches':          handleImportMatches,
    '/api/admin/import-official-draw':    handleImportOfficialDraw,
};

// Session and per-user payloads. Browsers, shared proxies, and the edge must
// not store these. Public routes are absent on purpose and keep their headers.
const PRIVATE_NO_STORE = new Set([
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/me',
    '/api/auth/update-profile',
    '/api/auth/change-password',
    '/api/favorites',
    '/api/favorites/toggle',
    '/api/bracket/mine',
    '/api/bracket/save',
]);

// ── CORS headers ──────────────────────────────────────────────────────────────
// Production: honor the configured CORS_ORIGIN.
// Dev: reflect any localhost / 127.0.0.1 origin so the UI works on any port
// (3000, 8080, …) without re-pinning a single value.
function corsHeaders(env, request) {
    const requestOrigin = request && request.headers.get('Origin');
    const isLocal = requestOrigin &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin);
    const allowOrigin = isLocal ? requestOrigin : (env.CORS_ORIGIN || '*');
    return {
        'Access-Control-Allow-Origin':  allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
        'Vary': 'Origin',
    };
}

// ── Cron: background KV cache refresh ────────────────────────────────────────
// Triggered every 6h by wrangler.toml [[triggers.crons]] (`0 */6 * * *`).
// Standings stay warm on every run. Rank snapshots are one KV write per
// player per day, so they run only when the scheduled UTC hour is 12.
// The calendar warm used to call /api/calendar with a date window nobody
// else requests; it now fills getCalendarYear for the current year.
export const RANK_SEED_UTC_HOUR = 12;

function scheduledInstant(event) {
    const raw = event && typeof event === 'object' && 'scheduledTime' in event
        ? event.scheduledTime
        : event;
    if (raw instanceof Date) return new Date(raw.getTime());
    if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
    return new Date();
}

export async function handleScheduled(env, event) {
    const TOURS = ['ATP', 'WTA'];
    const results = [];
    const when = scheduledInstant(event);
    const seedRanks = when.getUTCHours() === RANK_SEED_UTC_HOUR;

    for (const tour of TOURS) {
        // Standings every run. Rank snapshots only at RANK_SEED_UTC_HOUR.
        try {
            const req  = new Request(`https://placeholder/api/standings?tour=${tour}`);
            const data = await handleStandings(req, env);
            results.push(`standings:${tour}:ok`);
            if (seedRanks && Array.isArray(data)) {
                await seedRankSnapshots(env, tour, data.slice(0, 50));
                results.push(`rank-seed:${tour}:ok`);
            } else if (Array.isArray(data)) {
                results.push(`rank-seed:${tour}:skip`);
            }
        } catch (e) {
            results.push(`standings:${tour}:err:${e.message}`);
        }

        try {
            await getCalendarYear(env, tour, when.getFullYear(), when);
            results.push(`calendar:${tour}:ok`);
        } catch (e) {
            results.push(`calendar:${tour}:err:${e.message}`);
        }
    }

    console.log('[cron] KV refresh complete:', results.join(' | '));
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
    async scheduled(event, env) {
        await handleScheduled(env, event);
    },

    async fetch(request, env) {
        const { pathname } = new URL(request.url);

        // Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(env, request) });
        }

        let handler;
        if (request.method === 'GET')  handler = GET_ROUTES[pathname];
        if (request.method === 'POST') handler = POST_ROUTES[pathname];

        if (!handler) {
            return jsonResponse({ error: `Unknown route: ${pathname}` }, 404, env, request);
        }

        try {
            const data = await handler(request, env);
            return jsonResponse({ ok: true, data }, 200, env, request);
        } catch (err) {
            console.error(`[${pathname}]`, err.message);
            const status = err.status || 500;
            return jsonResponse({ ok: false, error: err.message }, status, env, request);
        }
    },
};

function jsonResponse(body, status, env, request) {
    const headers = {
        'Content-Type': 'application/json',
        ...corsHeaders(env, request),
    };
    const method = request && request.method;
    if ((method === 'GET' || method === 'POST') && PRIVATE_NO_STORE.has(new URL(request.url).pathname)) {
        headers['Cache-Control'] = 'private, no-store';
    }
    return new Response(JSON.stringify(body), { status, headers });
}
