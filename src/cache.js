// ===================================
// Two-Layer Cache
// ===================================
// Layer 1 — Cloudflare Cache API (edge, very fast, ~free)
//   Bypassed in local wrangler dev (Cache API unavailable) — silent fail.
//
// Layer 2 — Workers KV (persistent, global, survives restarts)
//   Primary entries have TTL set by each route.
//   Stale-backup entries have no TTL — survive upstream outages so we can
//   serve "Data from X minutes ago" instead of a blank page.
//
// Key format: "tw:{resource}:{discriminator}"
//   e.g. "tw:standings:ATP", "tw:hub:ATP", "tw:player:2072"
//   Stale copies appended with ":stale" — never expire.

const PREFIX = 'tw';

function buildKey(...parts) {
    return [PREFIX, ...parts.map(String)].join(':');
}

// ── Cache API helpers (Layer 1) ────────────────────────────────────────────────

function edgeUrl(key) {
    return `https://tennisworld-cache.internal/${key}`;
}

async function edgeGet(key) {
    try {
        const res = await caches.default.match(edgeUrl(key));
        if (!res) return null;
        return await res.json();
    } catch {
        return null; // not available in local dev
    }
}

async function edgePut(key, payload, ttlSeconds) {
    try {
        const res = new Response(JSON.stringify(payload), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${ttlSeconds}`,
            },
        });
        await caches.default.put(edgeUrl(key), res);
    } catch {
        // silent fail in local dev
    }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export const cache = {
    /**
     * get(env, ...keyParts)
     * Returns { data, stale: bool, cachedAt: ISO string } or null on miss.
     * Checks edge cache first, then KV.
     */
    async get(env, ...keyParts) {
        const key = buildKey(...keyParts);

        const edgeHit = await edgeGet(key);
        if (edgeHit) return edgeHit;

        const raw = await env.TENNIS_CACHE.get(key, { type: 'json' });
        return raw ?? null;
    },

    /**
     * set(env, ttlSeconds, value, ...keyParts)
     * Writes to edge cache + KV (with TTL), and updates the stale backup.
     */
    async set(env, ttlSeconds, value, ...keyParts) {
        const key      = buildKey(...keyParts);
        const staleKey = buildKey(...keyParts, 'stale');
        const cachedAt = new Date().toISOString();
        const payload  = { data: value, cachedAt, stale: false };

        // Layer 1: edge
        await edgePut(key, payload, ttlSeconds);

        // Layer 2: KV with TTL
        await env.TENNIS_CACHE.put(key, JSON.stringify(payload), {
            expirationTtl: ttlSeconds,
        });

        // Stale backup: no expiry — used as last-resort fallback
        await env.TENNIS_CACHE.put(
            staleKey,
            JSON.stringify({ data: value, cachedAt, stale: true }),
        );
    },

    /**
     * getStale(env, ...keyParts)
     * Returns the last-known value regardless of TTL expiry.
     * Used when the upstream API fails so we can still render something.
     */
    async getStale(env, ...keyParts) {
        const staleKey = buildKey(...keyParts, 'stale');
        const raw = await env.TENNIS_CACHE.get(staleKey, { type: 'json' });
        return raw ?? null;
    },

    /**
     * invalidate(env, ...keyParts)
     * Removes the primary cache entry (stale backup intentionally kept).
     */
    async invalidate(env, ...keyParts) {
        const key = buildKey(...keyParts);
        await env.TENNIS_CACHE.delete(key);
        try { await caches.default.delete(edgeUrl(key)); } catch { /* local dev */ }
    },
};
