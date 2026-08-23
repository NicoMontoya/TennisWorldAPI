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
import { handlePlayerRankHistory, seedRankSnapshots } from './routes/playerRankHistory.js';
import { handleBackfillRankings, handleClearRankHistory, handleImportRankHistory } from './routes/adminBackfill.js';
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
};

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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary': 'Origin',
    };
}

// ── Cron: background KV cache refresh ────────────────────────────────────────
// Triggered every 6h by wrangler.toml [[triggers.crons]].
// Warms the two slowest / least-volatile endpoints so the first user of the day
// always gets a fast cached response instead of a cold upstream fetch.
async function handleScheduled(env) {
    const TOURS = ['ATP', 'WTA'];
    const results = [];

    for (const tour of TOURS) {
        // Standings + seed rank snapshots for top-50
        try {
            const req  = new Request(`https://placeholder/api/standings?tour=${tour}`);
            const data = await handleStandings(req, env);
            results.push(`standings:${tour}:ok`);
            if (Array.isArray(data)) {
                await seedRankSnapshots(env, tour, data.slice(0, 50));
                results.push(`rank-seed:${tour}:ok`);
            }
        } catch (e) {
            results.push(`standings:${tour}:err:${e.message}`);
        }

        // Calendar (current month ±7 days)
        try {
            const today = new Date();
            const start = new Date(today); start.setDate(today.getDate() - 7);
            const stop  = new Date(today); stop.setDate(today.getDate() + 30);
            const fmt   = d => d.toISOString().split('T')[0];
            const req   = new Request(`https://placeholder/api/calendar?tour=${tour}&dateStart=${fmt(start)}&dateStop=${fmt(stop)}`);
            await handleCalendar(req, env);
            results.push(`calendar:${tour}:ok`);
        } catch (e) {
            results.push(`calendar:${tour}:err:${e.message}`);
        }
    }

    console.log('[cron] KV refresh complete:', results.join(' | '));
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
    async scheduled(_event, env) {
        await handleScheduled(env);
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
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(env, request),
        },
    });
}
