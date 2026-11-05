// Global daily upstream cap. One D1 row per provider per UTC day.
// Cache API and KV are the wrong place: the cache is per colo, and KV is
// eventually consistent last-write-wins, so parallel calls overshoot.
//
// One statement claims a slot. A returned row means this call may fetch.
// No row (cap already reached) or a thrown statement means do not fetch.

import { QuotaStopError } from './quotaStop.js';

export const CALL_TALLY_SQL = `INSERT INTO call_tally (provider, utc_day, count)
SELECT ?, ?, 1
WHERE ? > 0
ON CONFLICT(provider, utc_day) DO UPDATE SET count = count + 1
WHERE call_tally.count < ?
RETURNING count`;

function utcDay(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

/**
 * Claim one upstream slot. Throws QuotaStopError when D1 is missing, the
 * statement throws, or no row comes back (cap already reached).
 */
export async function claimCallSlot(env, provider, cap, now = new Date()) {
    const limit = Math.max(0, Math.floor(Number(cap) || 0));
    const db = env?.DB;
    if (!db || typeof db.prepare !== 'function') throw new QuotaStopError();
    let results;
    try {
        const res = await db.prepare(CALL_TALLY_SQL)
            .bind(provider, utcDay(now), limit, limit)
            .all();
        results = res?.results;
    } catch {
        throw new QuotaStopError();
    }
    if (!Array.isArray(results) || results.length === 0 || results[0]?.count == null) {
        throw new QuotaStopError();
    }
    return Number(results[0].count);
}
