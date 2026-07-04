import { cache }            from '../cache.js';
import { db }               from '../db.js';
import { apiTennis }        from '../apiClient.js';
import { transformPlayer }  from '../transforms/index.js';
import { TTL }              from '../config.js';

// GET /api/players?playerKey=123
export async function handlePlayer(request, env) {
    const { searchParams } = new URL(request.url);
    const playerKey = searchParams.get('playerKey');

    if (!playerKey) throw new Error('playerKey is required');

    // 1. Cache
    const cached = await cache.get(env, 'player', playerKey);
    if (cached) return cached.data;

    // 2. DB (Phase 2)
    const fromDB = await db.getPlayer(env, playerKey);
    if (fromDB) {
        await cache.set(env, TTL.players, fromDB, 'player', playerKey);
        return fromDB;
    }

    // 3. Live API — fall back to stale on error
    try {
        const raw  = await apiTennis.player(env, playerKey);
        const data = transformPlayer(raw);
        await Promise.all([
            cache.set(env, TTL.players, data, 'player', playerKey),
            db.upsertPlayer(env, data),
        ]);
        return data;
    } catch (err) {
        const stale = await cache.getStale(env, 'player', playerKey);
        if (stale) return stale.data;
        throw err;
    }
}
