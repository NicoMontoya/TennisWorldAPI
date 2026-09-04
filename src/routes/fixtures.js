import { cache }              from '../cache.js';
import { db }                 from '../db.js';
import { apiTennis }          from '../apiClient.js';
import { transformFixtures }  from '../transforms/index.js';
import { TTL }                from '../config.js';
import { parseTournamentKey } from '../security.js';

// GET /api/fixtures?dateStart=2025-01-01&dateStop=2025-01-07&tournamentKey=123
export async function handleFixtures(request, env) {
    const { searchParams } = new URL(request.url);
    const dateStart     = searchParams.get('dateStart')     || undefined;
    const dateStop      = searchParams.get('dateStop')      || undefined;
    const tournamentKey = parseTournamentKey(searchParams.get('tournamentKey'));

    const cacheKey = ['fixtures', tournamentKey || 'all', dateStart || '', dateStop || ''];

    // 1. Cache
    const cached = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    // 2. DB (Phase 2)
    const fromDB = await db.getFixtures(env, { tournamentKey, dateStart, dateStop });
    if (fromDB) {
        await cache.set(env, TTL.fixtures, fromDB, ...cacheKey);
        return fromDB;
    }

    // 3. Live API — fall back to stale on error
    try {
        const raw  = await apiTennis.fixtures(env, {
            ...(dateStart     && { date_start:    dateStart }),
            ...(dateStop      && { date_stop:      dateStop }),
            ...(tournamentKey && { tournament_key: tournamentKey }),
        });
        const data = transformFixtures(raw);
        await Promise.all([
            cache.set(env, TTL.fixtures, data, ...cacheKey),
            db.upsertFixtures(env, data),
        ]);
        return data;
    } catch (err) {
        const stale = await cache.getStale(env, ...cacheKey);
        if (stale) return stale.data;
        throw err;
    }
}
