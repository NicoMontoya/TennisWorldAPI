import { cache }                from '../cache.js';
import { apiTennis }            from '../apiClient.js';
import { transformTournaments } from '../transforms/index.js';
import { TTL, EVENT_TYPES }     from '../config.js';
import { tagAsOf } from '../asOf.js';
import { readApiTennisList, rememberApiTennisList } from '../d1Store.js';

// GET /api/tournaments?tour=ATP|WTA
export async function handleTournaments(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    const cached = await cache.get(env, 'tournaments', tour);
    if (cached) return cached.data;

    try {
        const raw  = await apiTennis.tournaments(env, EVENT_TYPES[tour]);
        const data = transformTournaments(raw);
        try { await rememberApiTennisList(env, 'tournaments', tour, data); } catch { /* last-good is best-effort */ }
        await cache.set(env, TTL.tournaments, data, 'tournaments', tour);
        return data;
    } catch {
        return serveStoredTournaments(env, tour);
    }
}

async function serveStoredTournaments(env, tour) {
    const saved = await readApiTennisList(env, 'tournaments', tour);
    if (saved?.hadRows) return tagAsOf(saved.rows.filter(row => row?.tournamentKey), saved.asOf);
    try {
        const stale = await cache.getStale(env, 'tournaments', tour);
        if (Array.isArray(stale?.data) && stale.data.length) {
            return tagAsOf(stale.data, stale.cachedAt || stale.fetchedAt);
        }
    } catch { /* empty list below */ }
    return [];
}
