// GET /api/rankings/surface-form?tour=ATP|WTA&surface=hard|clay|grass
//
// Surface form board for the active standings roster. Match win% is W / (W + L)
// on the selected surface over the last 52 weeks. Players with fewer than
// MIN_MATCHES on that surface are omitted.
//
// Sources (no upstream calls):
//   tw:standings2:{tour}              active roster (fresh, else stale backup)
//   tw:matches:v1:{tour}:{playerKey}  surface, won, date — same log H2H reads
//
// The client sends tour and surface only. playerKey values come from the
// standings roster and must be 1–10 digits. The walk is capped (roster size
// and how many recent log rows are inspected). The derived board is stored
// in the Cache API so a repeat request does not read KV again.

import { cache } from '../cache.js';
import { parseTour, rateLimit } from '../security.js';
import { readMatchLog } from './playerMatches.js';

export const MIN_MATCHES = 8;
export const WINDOW_DAYS = 52 * 7;
export const MAX_ROSTER = 2000;
export const MAX_MATCHES_SCAN = 200;
export const SURFACE_FORM_TTL = 6 * 60 * 60;
export const SURFACE_FORM_MISS_TTL = 10 * 60;

const SURFACES = new Set(['hard', 'clay', 'grass']);
const PLAYER_KEY_RE = /^\d{1,10}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const READ_CHUNK = 25;

function httpError(status, message) {
    throw Object.assign(new Error(message), { status });
}

export function surfaceFormAsOf(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

export function windowCutoff(asOf, windowDays = WINDOW_DAYS) {
    const [y, m, d] = asOf.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - windowDays);
    return dt.toISOString().slice(0, 10);
}

export function parseSurface(raw) {
    if (raw == null || String(raw).trim() === '') {
        httpError(400, 'Invalid surface. Expected hard, clay, or grass.');
    }
    const surface = String(raw).trim().toLowerCase();
    if (!SURFACES.has(surface)) {
        httpError(400, 'Invalid surface. Expected hard, clay, or grass.');
    }
    return surface;
}

function edgeParts(tour, surface) {
    return ['surface-form-v1', tour, surface];
}

function cleanName(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, 120);
}

function cleanCountry(raw) {
    if (typeof raw !== 'string') return undefined;
    const country = raw.trim().slice(0, 80);
    return country || undefined;
}

export function ageOn(birthday, asOf) {
    if (birthday == null || !ISO_DATE.test(asOf)) return null;
    const born = String(birthday).slice(0, 10);
    if (!ISO_DATE.test(born)) return null;
    let age = Number(asOf.slice(0, 4)) - Number(born.slice(0, 4));
    if (asOf.slice(5) < born.slice(5)) age -= 1;
    if (!Number.isInteger(age) || age < 0 || age > 120) return null;
    return age;
}

// Digit keys only, best official rank kept, then the top `max` by rank.
export function selectRoster(players, max = MAX_ROSTER) {
    const byKey = new Map();
    for (const p of (Array.isArray(players) ? players : [])) {
        const playerKey = String(p?.playerKey ?? '').trim();
        if (!PLAYER_KEY_RE.test(playerKey)) continue;
        const rankNum = Number(p?.rank);
        const rank = Number.isFinite(rankNum) && rankNum > 0 ? rankNum : Number.MAX_SAFE_INTEGER;
        const prev = byKey.get(playerKey);
        if (prev && prev.rank <= rank) continue;
        byKey.set(playerKey, {
            playerKey,
            name: cleanName(p?.name),
            country: cleanCountry(p?.country),
            birthday: p?.birthday ?? null,
            rank,
        });
    }
    return [...byKey.values()]
        .sort((a, b) => a.rank - b.rank || a.playerKey.localeCompare(b.playerKey))
        .slice(0, max);
}

// Logs are oldest → newest. Walk backward from the recent end, stop at the
// first in-order date outside the window, and never inspect more than maxScan
// rows. Only an exact surface token and a boolean `won` count.
export function tallySurface(matches, surface, cutoff, asOf, maxScan = MAX_MATCHES_SCAN) {
    let w = 0;
    let l = 0;
    let scanned = 0;
    const list = Array.isArray(matches) ? matches : [];
    for (let i = list.length - 1; i >= 0 && scanned < maxScan; i--) {
        scanned++;
        const m = list[i];
        if (!m || typeof m !== 'object') continue;
        const date = typeof m.date === 'string' ? m.date.slice(0, 10) : '';
        if (!ISO_DATE.test(date)) continue;
        if (date < cutoff) break;
        if (date > asOf) continue;
        const surf = typeof m.surface === 'string' ? m.surface.trim().toLowerCase() : '';
        if (surf !== surface) continue;
        if (m.won === true) w++;
        else if (m.won === false) l++;
    }
    return { w, l };
}

function rowFrom(player, matches, surface, cutoff, asOf) {
    const { w, l } = tallySurface(matches, surface, cutoff, asOf);
    const played = w + l;
    if (played < MIN_MATCHES) return null;
    const row = {
        playerKey: player.playerKey,
        name: player.name,
        w,
        l,
        winPct: Math.round((w / played) * 10000) / 10000,
    };
    if (player.country) row.country = player.country;
    const age = ageOn(player.birthday, asOf);
    if (age != null) row.age = age;
    return row;
}

function compareRows(a, b) {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    const played = (b.w + b.l) - (a.w + a.l);
    if (played !== 0) return played;
    const name = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (name !== 0) return name;
    return a.playerKey.localeCompare(b.playerKey);
}

function board({ tour, surface, asOf, rows, reason }) {
    const body = {
        tour,
        surface,
        asOf,
        windowDays: WINDOW_DAYS,
        minMatches: MIN_MATCHES,
        rows,
    };
    if (reason) body.reason = reason;
    return body;
}

async function readStandingsRoster(env, tour) {
    const fresh = await cache.get(env, 'standings2', tour);
    if (Array.isArray(fresh?.data)) return fresh.data;
    const stale = await cache.getStale(env, 'standings2', tour);
    if (Array.isArray(stale?.data)) return stale.data;
    return null;
}

async function buildRows(env, tour, surface, roster, cutoff, asOf) {
    const rows = [];
    for (let i = 0; i < roster.length; i += READ_CHUNK) {
        const chunk = roster.slice(i, i + READ_CHUNK);
        const logs = await Promise.all(chunk.map(p => readMatchLog(env, tour, p.playerKey)));
        for (let j = 0; j < chunk.length; j++) {
            const row = rowFrom(chunk[j], logs[j], surface, cutoff, asOf);
            if (row) rows.push(row);
        }
    }
    rows.sort(compareRows);
    return rows.map((row, i) => ({ rank: i + 1, ...row }));
}

export async function handleSurfaceForm(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = parseTour(searchParams.get('tour'));
    const surface = parseSurface(searchParams.get('surface'));

    await rateLimit(env, request, 'surface-form');

    const hit = await cache.getEdge(...edgeParts(tour, surface));
    if (hit?.data?.tour === tour && hit.data.surface === surface && Array.isArray(hit.data.rows)) {
        return hit.data;
    }

    const asOf = surfaceFormAsOf();
    const roster = await readStandingsRoster(env, tour);
    if (!roster) {
        const miss = board({
            tour,
            surface,
            asOf,
            rows: [],
            reason: 'standings-not-loaded',
        });
        await cache.setEdge(SURFACE_FORM_MISS_TTL, miss, ...edgeParts(tour, surface));
        return miss;
    }

    const cutoff = windowCutoff(asOf);
    const rows = await buildRows(env, tour, surface, selectRoster(roster), cutoff, asOf);
    const body = board({ tour, surface, asOf, rows });
    await cache.setEdge(SURFACE_FORM_TTL, body, ...edgeParts(tour, surface));
    return body;
}
