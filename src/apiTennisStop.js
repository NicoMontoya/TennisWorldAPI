// API-Tennis.com hard stop. Separate from the RapidAPI stop in quotaStop.js.
// call() is the only caller. rapidFetch does not consult this.
//
// API_TENNIS_HARD_STOP (Worker var, not a request):
//   on    — stop after a 429, or once today's call tally hits the cap
//   off   — never stop
//   force — skip API-Tennis calls immediately
// Only those exact strings count. Unset defaults to on (RapidAPI defaults to off).
// Any other present value behaves as on.
//
// The shared flag is tw:api-tennis:stop:v1 = { until }. The per-day tally is
// a Cache API entry keyed by UTC day, not KV, so a call does not spend a
// KV write. `force` never fetches and does not increment the tally.
// A 429 trips the stop. It is not retried.

import { QuotaStopError, clampQuotaReset } from './quotaStop.js';

export const API_TENNIS_FLAG_KEY = 'tw:api-tennis:stop:v1';
export const DEFAULT_API_TENNIS_DAILY_CAP = 100;

const FLAG_EDGE = 'https://api-tennis.internal/stop';
const LOCAL_STOP_EDGE = 'https://api-tennis.internal/local-stop';
const TALLY_EDGE = 'https://api-tennis.internal/call-tally';
const FLAG_EDGE_TTL = 60;
const TALLY_TTL = 24 * 60 * 60;

let claimedUntil = 0;

export function resetApiTennisStopStateForTests() {
    claimedUntil = 0;
}

export function apiTennisHardStopMode(env) {
    if (!env || env.API_TENNIS_HARD_STOP === undefined) return 'on';
    const raw = env.API_TENNIS_HARD_STOP;
    if (raw === 'on' || raw === 'off' || raw === 'force') return raw;
    return 'on';
}

export function apiTennisDailyCap(env) {
    const raw = env?.API_TENNIS_DAILY_CAP;
    if (raw == null || String(raw).trim() === '') return DEFAULT_API_TENNIS_DAILY_CAP;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_API_TENNIS_DAILY_CAP;
    return Math.floor(n);
}

function utcDay(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

function cacheApi() {
    const cache = globalThis.caches?.default;
    if (!cache || typeof cache.match !== 'function' || typeof cache.put !== 'function') return null;
    return cache;
}

async function edgeGet(url) {
    const cache = cacheApi();
    if (!cache) return null;
    const res = await cache.match(url);
    if (!res) return null;
    return res.json();
}

async function edgePut(url, value, ttlSeconds) {
    const cache = cacheApi();
    if (!cache) return;
    const res = new Response(JSON.stringify(value), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${ttlSeconds}`,
        },
    });
    await cache.put(url, res);
}

async function readTally() {
    const day = utcDay();
    try {
        const cur = await edgeGet(TALLY_EDGE);
        if (!cur || cur.day !== day) return { day, count: 0 };
        const count = Number(cur.count);
        return { day, count: Number.isFinite(count) && count > 0 ? count : 0 };
    } catch {
        return null;
    }
}

/**
 * Record one API-Tennis attempt before fetch. A thrown counter read or write
 * fails closed (QuotaStopError) so the caller does not hit upstream.
 * No-op unless the stop is `on`.
 */
export async function commitApiTennisCall(env) {
    if (apiTennisHardStopMode(env) !== 'on') return;
    const tally = await readTally();
    if (!tally || tally.count >= apiTennisDailyCap(env) || !cacheApi()) {
        throw new QuotaStopError();
    }
    try {
        await edgePut(TALLY_EDGE, { day: tally.day, count: tally.count + 1 }, TALLY_TTL);
    } catch {
        throw new QuotaStopError();
    }
}

async function tripLocal(ttlSec) {
    const until = Date.now() + ttlSec * 1000;
    try {
        await edgePut(LOCAL_STOP_EDGE, { until }, ttlSec);
    } catch { /* shared flag is the durable copy */ }
}

async function tripShared(env, ttlSec) {
    const until = Date.now() + ttlSec * 1000;
    if (claimedUntil > Date.now()) {
        try {
            await edgePut(FLAG_EDGE, { checked: true, active: true, until: claimedUntil }, FLAG_EDGE_TTL);
        } catch { /* ignore */ }
        return;
    }
    claimedUntil = until;
    try {
        const existing = await env.TENNIS_CACHE.get(API_TENNIS_FLAG_KEY, { type: 'json' });
        if (Number(existing?.until) > Date.now()) {
            claimedUntil = Number(existing.until);
            try {
                await edgePut(FLAG_EDGE, { checked: true, active: true, until: claimedUntil }, FLAG_EDGE_TTL);
            } catch { /* ignore */ }
            return;
        }
        await env.TENNIS_CACHE.put(
            API_TENNIS_FLAG_KEY,
            JSON.stringify({ until }),
            { expirationTtl: ttlSec },
        );
    } catch {
        // Leave the latch set so a failing put is not retried on every request.
    }
    try {
        await edgePut(FLAG_EDGE, { checked: true, active: true, until }, FLAG_EDGE_TTL);
    } catch { /* ignore */ }
}

/** 429 while the setting is on. One shot — callers must not retry. */
export async function tripApiTennisOn429(env) {
    if (apiTennisHardStopMode(env) !== 'on') return;
    const ttl = clampQuotaReset(null);
    await tripLocal(ttl);
    await tripShared(env, ttl);
}

/**
 * true when this call must not hit api.api-tennis.com.
 * `off` is never stopped. `force` is always stopped.
 * `on` stops for a tripped flag or a full daily tally.
 * A thrown flag or tally read fails closed.
 */
export async function isApiTennisStopActive(env) {
    const mode = apiTennisHardStopMode(env);
    if (mode === 'off') return false;
    if (mode === 'force') return true;

    try {
        const local = await edgeGet(LOCAL_STOP_EDGE);
        if (local && Number(local.until) > Date.now()) return true;
    } catch {
        return true;
    }

    try {
        const tally = await readTally();
        if (!tally) return true;
        if (tally.count >= apiTennisDailyCap(env)) return true;
    } catch {
        return true;
    }

    try {
        const cached = await edgeGet(FLAG_EDGE);
        if (cached?.checked === true) {
            return cached.active === true && Number(cached.until) > Date.now();
        }
    } catch {
        return true;
    }

    try {
        const raw = await env?.TENNIS_CACHE?.get(API_TENNIS_FLAG_KEY, { type: 'json' });
        const until = Number(raw?.until);
        const active = Number.isFinite(until) && until > Date.now();
        try {
            await edgePut(FLAG_EDGE, { checked: true, active, until: active ? until : 0 }, FLAG_EDGE_TTL);
        } catch { /* next request may read KV again */ }
        return active;
    } catch {
        return true;
    }
}

export function apiTennisStopped() {
    console.warn('[quota] api-tennis hard stop active');
    throw new QuotaStopError();
}
