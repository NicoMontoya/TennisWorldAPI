// ===================================
// TennisWorld API — Cloudflare Worker
// ===================================
// Entry point. Handles routing, CORS, and error formatting.
// All business logic lives in src/routes/*.

import { handleStandings }        from './routes/standings.js';
import { handlePlayerStats }      from './routes/playerStats.js';
import { handleLivescore, recallLivescoreFetchedAt } from './routes/livescore.js';
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
import { isQuotaStop } from './quotaStop.js';
import { LIVESCORE_FETCHED_AT_UNKNOWN, normalizeFetchedAt, takeFetchedAt } from './fetchedAt.js';
import { readAsOf } from './asOf.js';
import { publicErrorMessage } from './publicError.js';
import { handleBackfillRankings, handleClearRankHistory, handleImportRankHistory, handleImportMatches } from './routes/adminBackfill.js';
import { handleBackfillLastGood } from './routes/adminLastGood.js';
import { handleImportOfficialDraw } from './routes/officialDrawAdmin.js';
import { handleRankingsHistory, handleImportRankingsHistory } from './routes/rankingsHistory.js';
import { handleSurfaceForm } from './routes/surfaceForm.js';
import {
    handleRegister, handleLogin, handleLogout, handleRedeem, handleMe,
    handleUpdateProfile, handleChangePassword, handleAdminRevokeMember,
    assertMember, isMemberRoute, takeSetCookies,
} from './routes/auth.js';
import { handleCreateInvite, handleRevokeInvite, handleListInvites } from './routes/invites.js';
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
    '/api/rankings/surface-form':       handleSurfaceForm,
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
    '/api/auth/redeem':           handleRedeem,
    '/api/auth/update-profile':   handleUpdateProfile,
    '/api/auth/change-password':  handleChangePassword,
    '/api/admin/invites':         handleCreateInvite,
    '/api/admin/invites/revoke':  handleRevokeInvite,
    '/api/admin/invites/list':    handleListInvites,
    '/api/admin/members/revoke':  handleAdminRevokeMember,
    '/api/favorites/toggle':          handleFavoritesToggle,
    '/api/bracket/save':              handleBracketSave,
    '/api/admin/import-rank-history': handleImportRankHistory,
    '/api/admin/import-rankings-history': handleImportRankingsHistory,
    '/api/admin/import-vintage':          handleImportVintage,
    '/api/admin/import-vintage-rank-by-age': handleImportVintageRankByAge,
    '/api/admin/import-matches':          handleImportMatches,
    '/api/admin/import-official-draw':    handleImportOfficialDraw,
    '/api/admin/backfill-rankings':       handleBackfillRankings,
    '/api/admin/clear-rank-history':      handleClearRankHistory,
    '/api/admin/backfill-last-good':      handleBackfillLastGood,
};

// Sprint 1 shell. The client router pushStates these paths. /rankings is an
// existing page served by the assets binding and is not rewritten here.
const SPRINT1_PATHS = new Set(['/today', '/schedule', '/picks', '/me']);

export function sprint1ShellPath(pathname) {
    if (typeof pathname !== 'string' || pathname.includes('//')) return null;
    const bare = pathname.length > 1 && pathname.endsWith('/')
        ? pathname.slice(0, -1)
        : pathname;
    return SPRINT1_PATHS.has(bare) ? bare : null;
}

// Session, invite, and per-user payloads. Browsers, shared proxies, and the
// edge must not store these. Public routes are absent on purpose.
const PRIVATE_NO_STORE = new Set([
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/redeem',
    '/api/auth/me',
    '/api/auth/update-profile',
    '/api/auth/change-password',
    '/api/favorites',
    '/api/favorites/toggle',
    '/api/bracket/mine',
    '/api/bracket/save',
    '/api/bracket/leaders',
    '/api/bracket/public',
    '/api/admin/invites',
    '/api/admin/invites/revoke',
    '/api/admin/invites/list',
    '/api/admin/members/revoke',
]);

export const ROBOTS_TAG = 'noindex, nofollow';
const ROBOTS_META = '<meta name="robots" content="noindex,nofollow">';
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

export function injectRobotsMeta(html) {
    if (typeof html !== 'string') return html;
    if (/<meta\s[^>]*name\s*=\s*["']robots["']/i.test(html)) return html;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${ROBOTS_META}`);
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}${ROBOTS_META}`);
    return ROBOTS_META + html;
}

function isPrivateNoStore(pathname) {
    return PRIVATE_NO_STORE.has(pathname) || isMemberRoute(pathname);
}

// Every state-changing POST: JSON body and a same-origin Origin. A missing
// or cross-site Origin is 403. The admin secret does not bypass this.
function assertJsonSameOrigin(request) {
    let expected = '';
    try { expected = new URL(request.url).origin; } catch { expected = ''; }
    const origin = request.headers.get('Origin');
    if (!origin || origin !== expected) {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
    const media = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (media !== 'application/json') {
        throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
    }
}

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
// Standings stay warm on every run. Rank snapshots run only when the
// scheduled UTC hour is 12, and only for a feed ranking date that is not
// already stored (no rewrite of the same week).
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
            const headers = new Headers(corsHeaders(env, request));
            headers.set('X-Robots-Tag', ROBOTS_TAG);
            return new Response(null, { status: 204, headers });
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/robots.txt') {
            return headIfNeeded(request, robotsTxtResponse());
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && sprint1ShellPath(pathname)) {
            return headIfNeeded(request, await serveSprint1Shell(request, env, pathname));
        }

        let handler;
        if (request.method === 'GET')  handler = GET_ROUTES[pathname];
        if (request.method === 'POST') handler = POST_ROUTES[pathname];

        if (!handler) {
            if (request.method === 'GET' || request.method === 'POST' || request.method === 'HEAD') {
                if (isMemberRoute(pathname) && request.method !== 'HEAD') {
                    try {
                        if (request.method === 'POST') assertJsonSameOrigin(request);
                        await assertMember(request, env);
                    } catch (err) {
                        return errorResponse(err, request, env, pathname);
                    }
                }
            }
            if ((request.method === 'GET' || request.method === 'HEAD') && !pathname.startsWith('/api')) {
                const asset = await serveBoundAsset(request, env);
                if (asset) return headIfNeeded(request, asset);
            }
            return jsonResponse({ error: `Unknown route: ${pathname}` }, 404, env, request);
        }

        try {
            if (request.method === 'POST') assertJsonSameOrigin(request);
            if (isMemberRoute(pathname)) await assertMember(request, env);
            const data = await handler(request, env);
            const cookies = takeSetCookies(data);
            // Scores polls /api/livescore and still expects data to be the match
            // array. The upstream time is a response header, not a body field.
            // The header is always set so a missing header cannot signal a stop.
            // Last-good calendar/draws/fixtures/standings keep that same data
            // shape and add a top-level asOf only when the copy is stored.
            const extra = livescoreFetchedAtHeaders(pathname, request, takeFetchedAt(data));
            const body = { ok: true, data };
            const asOf = readAsOf(data);
            if (asOf) body.asOf = asOf;
            return jsonResponse(body, 200, env, request, extra, cookies);
        } catch (err) {
            return errorResponse(err, request, env, pathname);
        }
    },
};

function errorResponse(err, request, env, pathname) {
    const message = publicErrorMessage(err);
    console.error(`[${pathname}]`, message);
    const status = err.status || 500;
    // QuotaStopError's message is already generic. Force it anyway so a
    // remaining count or stop flag can never reach the client.
    const extra = livescoreFetchedAtHeaders(
        pathname,
        request,
        thrownLivescoreFetchedAt(request),
    );
    return jsonResponse({ ok: false, error: message }, status, env, request, extra);
}

function thrownLivescoreFetchedAt(request) {
    try {
        const { searchParams } = new URL(request.url);
        return recallLivescoreFetchedAt(
            searchParams.get('tour'),
            searchParams.get('tournamentKey'),
        ) || LIVESCORE_FETCHED_AT_UNKNOWN;
    } catch {
        return LIVESCORE_FETCHED_AT_UNKNOWN;
    }
}

function livescoreFetchedAtHeaders(pathname, request, fetchedAt) {
    if (pathname !== '/api/livescore') return undefined;
    const headers = { 'X-Fetched-At': normalizeFetchedAt(fetchedAt) };
    // Cross-origin readers (localhost dev, or a CORS_ORIGIN host) cannot see
    // this header unless it is exposed. Same-origin GETs omit Origin.
    if (request && request.headers.get('Origin')) {
        headers['Access-Control-Expose-Headers'] = 'X-Fetched-At';
    }
    return headers;
}

const SHELL_REDIRECT = new Set([301, 302, 303, 307, 308]);

// html_handling may 307 /sprint1.html → /sprint1. Follow that once on the
// server so the browser stays on /today (or /schedule, /picks, /me).
function shellAssetLocation(location, base) {
    if (!location || typeof location !== 'string') return null;
    let url;
    try { url = new URL(location, base); } catch { return null; }
    let baseUrl;
    try { baseUrl = new URL(base); } catch { return null; }
    if (url.origin !== baseUrl.origin) return null;
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/sprint1') return null;
    return url.toString();
}

async function fetchSprint1Asset(assets, pageUrl) {
    const origin = new URL(pageUrl).origin;
    const htmlUrl = `${origin}/sprint1.html`;
    const first = await assets.fetch(new Request(htmlUrl, { method: 'GET' }));
    if (!SHELL_REDIRECT.has(first.status)) return first;
    const next = shellAssetLocation(first.headers.get('Location'), htmlUrl);
    if (!next) return first;
    return assets.fetch(new Request(next, { method: 'GET' }));
}

async function serveSprint1Shell(request, env, pathname) {
    const assets = env?.ASSETS;
    if (!assets || typeof assets.fetch !== 'function') {
        return jsonResponse({ error: `Unknown route: ${pathname}` }, 404, env, request);
    }

    let asset;
    try {
        asset = await fetchSprint1Asset(assets, request.url);
    } catch {
        return jsonResponse({ error: `Unknown route: ${pathname}` }, 404, env, request);
    }
    // Never hand the html_handling redirect to the browser.
    if (SHELL_REDIRECT.has(asset.status)) {
        return jsonResponse({ error: `Unknown route: ${pathname}` }, 404, env, request);
    }

    const headers = new Headers(asset.headers);
    headers.delete('Location');
    headers.set('X-Robots-Tag', ROBOTS_TAG);
    if (!headers.get('Content-Type')?.toLowerCase().includes('html')) {
        headers.set('Content-Type', 'text/html; charset=utf-8');
    }
    const html = injectRobotsMeta(await asset.text());
    return new Response(html, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
    });
}

function robotsTxtResponse() {
    return new Response(ROBOTS_TXT, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Robots-Tag': ROBOTS_TAG,
            'Cache-Control': 'public, max-age=300',
        },
    });
}

function headIfNeeded(request, response) {
    if (!request || request.method !== 'HEAD') return response;
    return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

// Assets the platform would have served before the worker. run_worker_first
// sends them here so the robots header is on the bytes we return.
async function serveBoundAsset(request, env) {
    const assets = env?.ASSETS;
    if (!assets || typeof assets.fetch !== 'function') return null;
    let asset;
    try {
        asset = await assets.fetch(new Request(request.url, {
            method: 'GET',
            headers: request.headers,
        }));
    } catch {
        return null;
    }
    if (!asset || asset.status === 404) return null;
    const headers = new Headers(asset.headers);
    headers.set('X-Robots-Tag', ROBOTS_TAG);
    const type = headers.get('Content-Type') || '';
    if (!/html/i.test(type)) {
        return new Response(asset.body, {
            status: asset.status,
            statusText: asset.statusText,
            headers,
        });
    }
    const html = injectRobotsMeta(await asset.text());
    return new Response(html, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
    });
}

function jsonResponse(body, status, env, request, extraHeaders, cookies) {
    const headers = new Headers({
        'Content-Type': 'application/json',
        ...corsHeaders(env, request),
        ...(extraHeaders || {}),
    });
    headers.set('X-Robots-Tag', ROBOTS_TAG);
    if (request) {
        let path = '';
        try { path = new URL(request.url).pathname; } catch { path = ''; }
        const method = request.method;
        if ((method === 'GET' || method === 'POST' || method === 'HEAD') && isPrivateNoStore(path)) {
            headers.set('Cache-Control', 'private, no-store');
        }
    }
    if (Array.isArray(cookies)) {
        for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    }
    return new Response(JSON.stringify(body), { status, headers });
}
