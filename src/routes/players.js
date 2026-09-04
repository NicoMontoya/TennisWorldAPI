import { cache }                from '../cache.js';
import { rapidAPI }             from '../apiClient.js';
import { transformRapidProfile } from '../transforms/index.js';
import { TTL }                  from '../config.js';

// GET /api/players?playerKey=123&tour=ATP
//
// Identity/profile now comes from RapidAPI (player/profile), which shares its ID
// namespace with draws, fixtures and rankings — the keys used everywhere else on
// the site. The previous source (api-tennis.com, via apiTennis.player + the players
// DB) used a DIFFERENT namespace, so the SAME numeric key resolved to a different
// person: e.g. draw key 46722 ("Jeff Wolf", USA, #248) came back as an unrelated
// France-flagged 1970 player. That was the "Jeff Wolf from France" bug.
//
// Cache key is scoped by tour (`player:<TOUR>:<key>`) — profile ids are per-tour and
// this also side-steps any stale entries written under the old `player:<key>` shape.
export async function handlePlayer(request, env) {
    const { searchParams } = new URL(request.url);
    const playerKey = searchParams.get('playerKey');
    if (!playerKey) throw new Error('playerKey is required');
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    const cached = await cache.get(env, 'player', tour, playerKey);
    if (cached) return cached.data;

    try {
        const raw  = await rapidAPI.playerProfile(env, tour, playerKey);
        const data = transformRapidProfile(raw);
        if (data) await cache.set(env, TTL.players, data, 'player', tour, playerKey);
        return data;
    } catch (err) {
        const stale = await cache.getStale(env, 'player', tour, playerKey);
        if (stale) return stale.data;
        throw err;
    }
}
