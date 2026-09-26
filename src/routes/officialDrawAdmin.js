// POST /api/admin/import-official-draw
// Body: { tournamentKey, season, tour, sourceHost, checkedAt, slots, checksum }
// Auth: x-admin-secret. Fail closed when ADMIN_SECRET is unset.
//
// One KV put of the canonical record (skipped when an identical record is
// already stored) plus deletes of the public draws cache entry and its stale
// backup, so the next /api/draws rebuilds from the sheet. Five events is
// well under the free-tier 1000 writes/day ceiling. This route does not
// fetch wtatennis.com / atptour.com — the script posts the record.

import { cache } from '../cache.js';
import {
    DRAWS_CACHE_RESOURCE,
    officialDrawKvKey,
    validateOfficialRecord,
} from '../officialDraw.js';

function unauthorized() {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
}

function badRequest(message) {
    throw Object.assign(new Error(message), { status: 400 });
}

async function invalidateDrawCache(env, tournamentKey, tour, season) {
    await cache.invalidate(env, DRAWS_CACHE_RESOURCE, tournamentKey, tour, season);
    try {
        await env.TENNIS_CACHE.delete(
            `tw:${DRAWS_CACHE_RESOURCE}:${tournamentKey}:${tour}:${season}:stale`,
        );
    } catch { /* quota / transient — the primary key is already gone */ }
}

export async function handleImportOfficialDraw(request, env) {
    const secret = request.headers.get('x-admin-secret') || '';
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) unauthorized();

    let body;
    try {
        body = await request.json();
    } catch {
        badRequest('Invalid JSON');
    }

    const validated = validateOfficialRecord(body);
    if (!validated.ok) badRequest(validated.error);
    const rec = validated.record;

    const key = officialDrawKvKey(rec.tour, rec.tournamentKey, rec.season);
    const existing = await env.TENNIS_CACHE.get(key, 'json');
    const same = existing
        && existing.checksum === rec.checksum
        && existing.sourceHost === rec.sourceHost
        && existing.checkedAt === rec.checkedAt
        && JSON.stringify(existing.slots) === JSON.stringify(rec.slots);
    if (!same) {
        await env.TENNIS_CACHE.put(key, JSON.stringify(rec));
    }
    await invalidateDrawCache(env, rec.tournamentKey, rec.tour, rec.season);

    return {
        ok: true,
        written: !same,
        tournamentKey: rec.tournamentKey,
        season: rec.season,
        tour: rec.tour,
        slots: rec.slots.length,
        checksum: rec.checksum,
    };
}
