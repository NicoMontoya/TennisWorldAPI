import { cache }                from '../cache.js';
import { apiTennis }            from '../apiClient.js';
import { transformTournaments } from '../transforms/index.js';
import { TTL, EVENT_TYPES }     from '../config.js';

// GET /api/tournaments?tour=ATP|WTA
export async function handleTournaments(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    const cached = await cache.get(env, 'tournaments', tour);
    if (cached) return cached.data;

    try {
        const raw  = await apiTennis.tournaments(env, EVENT_TYPES[tour]);
        const data = transformTournaments(raw);
        await cache.set(env, TTL.tournaments, data, 'tournaments', tour);
        return data;
    } catch (err) {
        const stale = await cache.getStale(env, 'tournaments', tour);
        if (stale) return stale.data;
        throw err;
    }
}
