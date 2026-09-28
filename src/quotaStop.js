// RapidAPI monthly-quota hard stop.
//
// RAPIDAPI_HARD_STOP (Worker var, not a request):
//   on    — after a response shows the quota is exhausted, skip further paid calls
//   off   — never stop (also the default when the var is unset or unrecognized)
//   force — skip paid calls immediately, flag or not
// There is no route that changes it.
//
// The shared flag is one KV key, tw:quota:stop:v1 = { until }, written at most
// once per trip. Each isolate reads that flag through a 60s Cache API entry,
// not a KV read on every request. A flag read that throws fails closed (no
// paid call).
//
// Backup: if x-ratelimit-requests-remaining is missing on
// QUOTA_HEADER_MISS_THRESHOLD (3) consecutive responses in this location, the
// isolate stops locally. That counter lives in the Cache API only (10 min
// TTL) and never writes KV. The local stop lasts for the clamped reset
// (default 24h when the reset header is missing or not a number).
//
// x-ratelimit-requests-reset is seconds. It is clamped to 60s–31 days.
// Missing or non-numeric reset uses 24h.

export const QUOTA_FLAG_KEY = 'tw:quota:stop:v1';
export const QUOTA_FLAG_EDGE_TTL = 60;
export const QUOTA_RESET_MIN_SEC = 60;
export const QUOTA_RESET_MAX_SEC = 31 * 24 * 60 * 60;
export const QUOTA_RESET_DEFAULT_SEC = 24 * 60 * 60;
export const QUOTA_HEADER_MISS_THRESHOLD = 3;

const FLAG_EDGE = 'https://quota.internal/stop';
const LOCAL_STOP_EDGE = 'https://quota.internal/local-stop';
const MISS_STREAK_EDGE = 'https://quota.internal/miss-streak';
const MISS_STREAK_TTL = 10 * 60;

// One isolate must not write the shared flag more than once per trip.
let claimedUntil = 0;

export function resetQuotaStopStateForTests() {
    claimedUntil = 0;
}

export class QuotaStopError extends Error {
    constructor() {
        super('Upstream request failed');
        this.name = 'QuotaStopError';
        this.status = 503;
    }
}

export function isQuotaStop(err) {
    return err instanceof QuotaStopError || err?.name === 'QuotaStopError';
}

export function hardStopMode(env) {
    const raw = String(env?.RAPIDAPI_HARD_STOP ?? '').trim().toLowerCase();
    if (raw === 'on' || raw === 'off' || raw === 'force') return raw;
    return 'off';
}

/** Seconds until we look again. Missing/invalid → 24h. Always within 60s–31d. */
export function clampQuotaReset(raw) {
    if (raw == null) return QUOTA_RESET_DEFAULT_SEC;
    const text = String(raw).trim();
    if (!text) return QUOTA_RESET_DEFAULT_SEC;
    const n = Number(text);
    if (!Number.isFinite(n)) return QUOTA_RESET_DEFAULT_SEC;
    return Math.min(QUOTA_RESET_MAX_SEC, Math.max(QUOTA_RESET_MIN_SEC, Math.floor(n)));
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

/**
 * true when this call must not hit RapidAPI.
 * `off` is never stopped. `force` is always stopped.
 * `on` stops when the local backup or the shared flag is active.
 * A thrown flag read fails closed.
 */
export async function isHardStopActive(env) {
    const mode = hardStopMode(env);
    if (mode === 'off') return false;
    if (mode === 'force') return true;

    try {
        const local = await edgeGet(LOCAL_STOP_EDGE);
        if (local && Number(local.until) > Date.now()) return true;
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
        const raw = await env.TENNIS_CACHE.get(QUOTA_FLAG_KEY, { type: 'json' });
        const until = Number(raw?.until);
        const active = Number.isFinite(until) && until > Date.now();
        try {
            await edgePut(FLAG_EDGE, { checked: true, active, until: active ? until : 0 }, QUOTA_FLAG_EDGE_TTL);
        } catch { /* next request may read KV again */ }
        return active;
    } catch {
        return true;
    }
}

// null header → missing. Non-numeric → bad. <= 0 → exhausted. > 0 → ok.
function classifyRemaining(headerValue) {
    if (headerValue == null) return 'missing';
    const text = String(headerValue).trim();
    if (!text) return 'missing';
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return 'exhausted';
    return 'ok';
}

async function bumpMissStreak() {
    let count = 0;
    try {
        const cur = await edgeGet(MISS_STREAK_EDGE);
        count = Number(cur?.count) || 0;
    } catch {
        count = 0;
    }
    count += 1;
    try {
        await edgePut(MISS_STREAK_EDGE, { count }, MISS_STREAK_TTL);
    } catch { /* counter is best-effort */ }
    return count;
}

async function resetMissStreak() {
    try {
        await edgePut(MISS_STREAK_EDGE, { count: 0 }, MISS_STREAK_TTL);
    } catch { /* best-effort */ }
}

async function tripLocal(ttlSec) {
    const until = Date.now() + ttlSec * 1000;
    try {
        await edgePut(LOCAL_STOP_EDGE, { until }, ttlSec);
    } catch { /* the shared flag is the durable copy */ }
}

async function tripShared(env, resetRaw) {
    const ttl = clampQuotaReset(resetRaw);
    const until = Date.now() + ttl * 1000;
    if (claimedUntil > Date.now()) {
        try {
            await edgePut(FLAG_EDGE, { checked: true, active: true, until: claimedUntil }, QUOTA_FLAG_EDGE_TTL);
        } catch { /* ignore */ }
        return;
    }
    claimedUntil = until;
    try {
        const existing = await env.TENNIS_CACHE.get(QUOTA_FLAG_KEY, { type: 'json' });
        if (Number(existing?.until) > Date.now()) {
            claimedUntil = Number(existing.until);
            try {
                await edgePut(FLAG_EDGE, { checked: true, active: true, until: claimedUntil }, QUOTA_FLAG_EDGE_TTL);
            } catch { /* ignore */ }
            return;
        }
        await env.TENNIS_CACHE.put(
            QUOTA_FLAG_KEY,
            JSON.stringify({ until }),
            { expirationTtl: ttl },
        );
    } catch {
        // Leave the latch set so a failing put is not retried on every request.
    }
    try {
        await edgePut(FLAG_EDGE, { checked: true, active: true, until }, QUOTA_FLAG_EDGE_TTL);
    } catch { /* ignore */ }
}

/** After a RapidAPI response. No-op unless the setting is `on`. */
export async function noteRapidQuota(env, response) {
    if (hardStopMode(env) !== 'on') return;
    let remaining;
    let reset;
    try {
        remaining = response?.headers?.get('x-ratelimit-requests-remaining');
        reset = response?.headers?.get('x-ratelimit-requests-reset');
    } catch {
        remaining = null;
        reset = null;
    }
    const state = classifyRemaining(remaining);
    if (state === 'ok') {
        await resetMissStreak();
        return;
    }
    if (state === 'missing') {
        const count = await bumpMissStreak();
        if (count >= QUOTA_HEADER_MISS_THRESHOLD) await tripLocal(clampQuotaReset(reset));
    } else {
        await resetMissStreak();
    }
    await tripShared(env, reset);
}
