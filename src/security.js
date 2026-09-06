// ===================================
// Scores soft-launch security helpers
// ===================================
// Hub/livescore rate-limit uses the Cache API (`caches.default`) so poll-heavy
// Scores tabs do not burn Workers KV write quota. Auth still uses KV in auth.js.
// Validation stops junk `tour` / `tournamentKey` values from minting cache keys
// or fanning out upstream calls.

export const RL_PER_MINUTE = { max: 60, windowSec: 60 };

// Synthetic Cache API URL — one key per bucket + IP (IPv6-safe).
export function rateLimitCacheUrl(bucket, ip) {
    return `https://rl.internal/${encodeURIComponent(bucket)}/${encodeURIComponent(ip)}`;
}

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
// Cache API key: https://rl.internal/${bucket}/${ip}
// Stores { count, windowStart } for a fixed window (Cache-Control max-age).
// Cache API missing / match-put failure / corrupt counter → 429, never skip.
// `env` is unused (call sites keep the same signature; no KV writes).

export async function rateLimit(env, request, bucket, { max, windowSec } = RL_PER_MINUTE) {
    const deny = () => httpError(429, 'Too many requests. Please try again shortly.');
    try {
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        if (!cache?.match || !cache?.put) deny();

        const ip  = request.headers.get('CF-Connecting-IP') || 'local';
        const key = new Request(rateLimitCacheUrl(bucket, ip));
        const now = Date.now();

        let count = 0;
        let windowStart = now;

        const cached = await cache.match(key);
        if (cached) {
            const data = await cached.json();
            const prevCount = Number(data?.count);
            const prevStart = Number(data?.windowStart);
            if (!Number.isFinite(prevCount) || !Number.isFinite(prevStart)) deny();
            if (now - prevStart < windowSec * 1000) {
                count = prevCount;
                windowStart = prevStart;
            }
        }

        const n = count + 1;
        if (!Number.isFinite(n) || n < 1) deny();

        const elapsedSec = Math.floor((now - windowStart) / 1000);
        const ttl = Math.max(1, windowSec - elapsedSec);
        await cache.put(key, new Response(JSON.stringify({ count: n, windowStart }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `max-age=${ttl}`,
            },
        }));

        if (n > max) deny();
    } catch (err) {
        if (err.status === 429) throw err;
        deny();
    }
}
