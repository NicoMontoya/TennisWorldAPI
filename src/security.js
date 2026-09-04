// ===================================
// Scores soft-launch security helpers
// ===================================
// KV rate-limit mirrors auth.js (`_rl:${bucket}:${ip}`, increment + TTL reset).
// Validation stops junk `tour` / `tournamentKey` values from minting cache keys
// or fanning out upstream calls.

export const RL_PER_MINUTE = { max: 60, windowSec: 60 };

// Digits-only RapidAPI / api-tennis tournament ids. Cap length so a huge
// numeric string cannot explode KV key space.
export const TOURNAMENT_KEY_RE = /^\d{1,20}$/;

function httpError(status, message) {
    throw Object.assign(new Error(message), { status });
}

// ── tour: ATP | WTA only (default ATP when omitted) ───────────────────────────

export function parseTour(raw) {
    if (raw == null || String(raw).trim() === '') return 'ATP';
    const tour = String(raw).trim().toUpperCase();
    if (tour !== 'ATP' && tour !== 'WTA') {
        httpError(400, 'Invalid tour. Expected ATP or WTA.');
    }
    return tour;
}

// ── tournamentKey: digits only; optional unless { required: true } ────────────
// Absent (null) + not required → undefined (caller uses "all").
// Empty / non-digit / too long → 400.

export function parseTournamentKey(raw, { required = false } = {}) {
    if (raw == null) {
        if (required) httpError(400, 'tournamentKey is required');
        return undefined;
    }
    const key = String(raw).trim();
    if (!TOURNAMENT_KEY_RE.test(key)) {
        httpError(400, key ? 'Invalid tournamentKey. Expected digits only.' : 'tournamentKey is required');
    }
    return key;
}

// ── Rate limit (fail closed) ──────────────────────────────────────────────────
// Key: `_rl:${bucket}:${ip}`  Window: TTL reset on each tick (same as auth).
// KV missing / get-put failure / non-numeric counter → 429, never skip.

export async function rateLimit(env, request, bucket, { max, windowSec } = RL_PER_MINUTE) {
    const deny = () => httpError(429, 'Too many requests. Please try again shortly.');
    try {
        if (!env?.TENNIS_CACHE?.get || !env?.TENNIS_CACHE?.put) deny();
        const ip  = request.headers.get('CF-Connecting-IP') || 'local';
        const key = `_rl:${bucket}:${ip}`;
        const n   = parseInt((await env.TENNIS_CACHE.get(key)) || '0', 10) + 1;
        if (!Number.isFinite(n) || n < 1) deny();
        await env.TENNIS_CACHE.put(key, String(n), { expirationTtl: windowSec });
        if (n > max) deny();
    } catch (err) {
        if (err.status === 429) throw err;
        deny();
    }
}
