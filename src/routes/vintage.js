import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';

// GET /api/vintage-roster?tour=ATP|WTA        → { roster }
// GET /api/player-vintage?tour=ATP|WTA&playerKey=47275 → { player, points, totals }
//
// Powers the "vintage" view: a player's cumulative win/match curve plotted
// against age, plus a picker roster of the current top-100.
//
// vintage-roster shape:
//   roster: [{ position, id, name, countryAcr }]
//
// player-vintage shape:
//   player: { id, name, countryAcr, birthday }
//   points: [{ age, w, m, t }]  // one per completed match, ascending age (w/m/t are cumulative)
//   totals: { wins, matches, titles }
//
// Caching: 24h — both derive from slow-moving upstream data (rankings + full match history).

const TTL_VINTAGE = 24 * 60 * 60;
const TTL_TIERMAP = 30 * 24 * 60 * 60;   // 30d — a past year's calendar is immutable

// ── Retired-legend vintage curves (from Jeff Sackmann match data) ───────────────
// Current top-100 players get live curves from RapidAPI (below). Retired greats
// (Federer, Nadal, McEnroe, Borg…) aren't in RapidAPI, so their curves are
// precomputed from Sackmann's full match archive (back to 1968) by
// scripts/backfill-vintage-legends.ts and stored in KV. They carry an 's'-prefixed
// id (the Sackmann player id) so the routes know which source to serve from.
const legendKey  = (tour, id)  => `tw:vintage:v1:${tour}:${id}`;
const legendsIdx = (tour)      => `tw:vintage-legends:v1:${tour}`;
const isLegendId = (key)       => typeof key === 'string' && key.startsWith('s');

const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
const PAGE_SIZE   = 500;
const MAX_PAGES   = 8;
const FINAL_ROUND = 12;                  // roundId of a tournament Final

// A "tournament won" (title) counts only tour-level finals. Calendar rankId tiers:
//   0 Futures · 1 Challenger · 2 Main tour (250/500) · 3 Masters · 4 Grand Slam · 5 Davis Cup · 7 Tour Finals
// Tour-level = {2,3,4,7} — mirrors the official ATP title count and excludes challenger/futures/team events.
const TOUR_LEVEL_TIERS = new Set([2, 3, 4, 7]);
const MASTERS_TIER = 3;   // Masters 1000
const SLAM_TIER    = 4;   // Grand Slam

// Build a { tournamentId → rankId } map spanning the given years. Each year's map
// is cached independently (immutable history) so it is shared across every player.
async function getTierMap(env, tour, years) {
    const map = {};
    // Sequential, not Promise.all: calendar() now pages ~5 requests/year (was 1,
    // pre-pagination-fix), so firing every year concurrently for a long career
    // (Djokovic: 23 years) bursts 100+ near-simultaneous RapidAPI requests,
    // exhausts rapidFetch's 429 retry budget, and the per-year catch below
    // silently empties the whole tier map — titles/masters/slams all read 0.
    // Each year is cached 30d, so the one-time sequential cold-fill cost is
    // paid once system-wide, not per player/request.
    for (const year of years) {
        // v2: bumped after fixing calendar() pagination (was truncating to ~201
        // of ~900 tournaments/year, dropping most Slams/Masters from the map).
        const ckey   = ['tier-map-v2', tour, String(year)];
        const cached = await cache.get(env, ...ckey);
        if (cached) { Object.assign(map, cached.data); continue; }

        let cal;
        try { cal = await rapidAPI.calendar(env, tour, year); }
        catch { continue; }   // one bad year must not sink the whole curve

        const yearMap = {};
        for (const t of (cal?.data || [])) {
            if (t.id != null && t.rankId != null) yearMap[t.id] = t.rankId;
        }
        await cache.set(env, TTL_TIERMAP, yearMap, ...ckey);
        Object.assign(map, yearMap);
    }
    return map;
}

// GET /api/vintage-roster?tour=ATP|WTA
// Current singles top-100, trimmed to the fields the picker needs.
export async function handleVintageRoster(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    const cacheKey = ['vintage-roster-v1', tour];
    const cached   = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    const ranking = await rapidAPI.rankings(env, tour, 100);
    const rows    = ranking?.data || [];

    const roster = rows.map(r => ({
        position:   r.position,
        id:         String(r.player?.id),
        name:       r.player?.name,
        countryAcr: r.player?.countryAcr,
    }));

    // Append retired legends (Sackmann-sourced) after the current top-100,
    // skipping any whose name already appears among current players (they're
    // served live). `legend: true` lets the picker group/label them.
    const legends = (await env.TENNIS_CACHE.get(legendsIdx(tour), 'json')) || [];
    const haveName = new Set(roster.map(r => (r.name || '').toLowerCase()));
    let pos = 100;
    for (const L of legends) {
        if (haveName.has((L.name || '').toLowerCase())) continue;
        roster.push({ position: ++pos, id: String(L.id), name: L.name, countryAcr: L.countryAcr, legend: true });
    }

    const data = { roster };

    if (roster.length) {
        await cache.set(env, TTL_VINTAGE, data, ...cacheKey);
    }

    return data;
}

// POST /api/admin/import-vintage
// Body: { tour, curves: { sId: { player, points, totals } }, legends: [{id,name,countryAcr}] }
// Auth: x-admin-secret header. Stores each legend's precomputed curve + the
// legends index the roster route merges in. Idempotent (overwrites).
export async function handleImportVintage(request, env) {
    const secret = request.headers.get('x-admin-secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }
    const { tour, curves, legends } = await request.json();
    if (!tour || !curves) throw new Error('tour and curves are required');
    const t = String(tour).toUpperCase();

    let written = 0;
    for (const [id, curve] of Object.entries(curves)) {
        await env.TENNIS_CACHE.put(legendKey(t, id), JSON.stringify(curve), { expirationTtl: 400 * 24 * 60 * 60 });
        written++;
    }
    if (Array.isArray(legends)) {
        // Merge with any existing index (dedup by id), keep sorted by wins desc.
        const existing = (await env.TENNIS_CACHE.get(legendsIdx(t), 'json')) || [];
        const byId = new Map(existing.map(l => [l.id, l]));
        for (const l of legends) byId.set(l.id, l);
        const merged = Array.from(byId.values()).sort((a, b) => (b.wins || 0) - (a.wins || 0));
        await env.TENNIS_CACHE.put(legendsIdx(t), JSON.stringify(merged));
    }
    // Invalidate the roster cache so new legends show up in the picker.
    await cache.invalidate(env, 'vintage-roster-v1', t);
    return { ok: true, written, legends: Array.isArray(legends) ? legends.length : 0 };
}

// GET /api/player-vintage?tour=ATP|WTA&playerKey=47275
// Cumulative wins/matches vs age, built from the player's full match history.
export async function handlePlayerVintage(request, env) {
    const { searchParams } = new URL(request.url);
    const tour      = (searchParams.get('tour') || 'ATP').toUpperCase();
    const playerKey = searchParams.get('playerKey');
    if (!playerKey) throw new Error('playerKey is required');

    // Retired legend (Sackmann-sourced, 's'-prefixed id): serve the precomputed
    // curve straight from KV. Same shape as the live path below.
    if (isLegendId(playerKey)) {
        const curve = await env.TENNIS_CACHE.get(legendKey(tour, playerKey), 'json');
        if (curve) return curve;
        return { player: { id: playerKey, name: null }, points: [], totals: { wins: 0, matches: 0 }, error: 'not-loaded' };
    }

    // v6: bumped a third time — v5's deploy still ran before the tier-map was
    // pre-warmed (scripts/backfill-tier-map.ts), so a long-career player's
    // first live request still hit Cloudflare's per-request subrequest
    // ceiling mid-computation and cached partial (undercount) totals for 24h.
    // The tier map is now fully pre-warmed 1996-2026, so this generation
    // should be the last cache-poisoning incident from this bug.
    const cacheKey = ['player-vintage-v6', tour, playerKey];
    const cached   = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    const pid = Number(playerKey);

    // ── Profile + first page of matches in parallel ───────────────────────────
    const [profileResult, firstPageResult] = await Promise.allSettled([
        rapidAPI.playerProfile(env, tour, playerKey),
        rapidAPI.playerPastMatches(env, tour, playerKey, PAGE_SIZE, 1),
    ]);

    const profile = profileResult.status === 'fulfilled' ? (profileResult.value?.data || {}) : {};
    const birthday = profile.birthday || null;

    const player = {
        id:         pid,
        name:       profile.name       || null,
        countryAcr: profile.countryAcr || null,
        birthday,
    };

    // No birthday → age can't be computed. Return an explicit marker, don't cache.
    if (!birthday) {
        return {
            player,
            points: [],
            totals: { wins: 0, matches: 0 },
            error:  'no-birthday',
        };
    }

    // ── Accumulate all matches (first page already fetched) ────────────────────
    const matches = [];
    let firstPage = firstPageResult.status === 'fulfilled' ? firstPageResult.value : null;

    // If the first page failed, retry it once inside the paging loop below by
    // starting from page 1; otherwise seed with what we have.
    let pageNo      = 1;
    let hasNextPage = false;

    if (firstPage) {
        matches.push(...(firstPage.data || []));
        hasNextPage = Boolean(firstPage.hasNextPage);
    } else {
        // First-page fetch rejected — re-enter the loop at page 1.
        hasNextPage = true;
        pageNo = 0;
    }

    while (hasNextPage && pageNo < MAX_PAGES) {
        pageNo++;
        let page;
        try {
            page = await rapidAPI.playerPastMatches(env, tour, playerKey, PAGE_SIZE, pageNo);
        } catch {
            // Upstream hiccup on a follow-up page: stop paging, keep what we have.
            break;
        }
        matches.push(...(page?.data || []));
        hasNextPage = Boolean(page?.hasNextPage);
    }

    // ── Build cumulative age curve ────────────────────────────────────────────
    const birthMs = new Date(birthday).getTime();

    const dated = matches
        .filter(m => m.date)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Tier map for the years this player actually competed — powers title detection.
    const years   = [...new Set(dated.map(m => new Date(m.date).getFullYear()))];
    const tierMap = await getTierMap(env, tour, years);

    const points = [];
    let wins    = 0;
    let played  = 0;
    let titles  = 0;
    let masters = 0;
    let slams   = 0;

    for (const m of dated) {
        played++;
        const won = m.match_winner === pid;
        if (won) wins++;

        // Titles by tier — a Final (roundId 12) won at a tour-level event.
        // Unknown-tier events count for nothing (avoids challenger/futures contamination).
        if (won && m.roundId === FINAL_ROUND) {
            const tier = tierMap[m.tournamentId];
            if (TOUR_LEVEL_TIERS.has(tier)) titles++;
            if (tier === MASTERS_TIER)      masters++;
            if (tier === SLAM_TIER)         slams++;
        }

        const age = Math.round(((new Date(m.date).getTime() - birthMs) / MS_PER_YEAR) * 100) / 100;
        points.push({ age, w: wins, m: played, t: titles, ms: masters, gs: slams });
    }

    const data = {
        player,
        points,
        totals: { wins, matches: played, titles, masters, slams },
    };

    if (points.length) {
        await cache.set(env, TTL_VINTAGE, data, ...cacheKey);
    }

    return data;
}
