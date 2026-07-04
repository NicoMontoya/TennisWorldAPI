import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL }      from '../config.js';

// GET /api/standings?tour=ATP|WTA
// Returns all players currently ranked (with ATP/WTA points), sorted by rank.
// Uses pageSize=2000 to get the full list, then filters to the latest ranking date.
export async function handleStandings(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    const cached = await cache.get(env, 'standings2', tour);
    if (cached) return cached.data;

    try {
        // Fetch enough rows to cover all ranked players in one call.
        // The API returns multiple weeks; filter to the most recent date.
        const raw      = await rapidAPI.rankings(env, tour, 2000);
        const allItems = raw?.data || [];

        // Find the latest ranking date present in the response
        const latestDate = allItems.reduce((best, i) => {
            if (!i.date) return best;
            return !best || i.date > best ? i.date : best;
        }, '');

        const items = latestDate
            ? allItems.filter(i => i.date === latestDate)
            : allItems;

        const data = items
            .filter(r => r.player?.id)
            .map(r => ({
                rank:      r.position                  || 0,
                movement:  r.player?.progress > 0 ? 1 : r.player?.progress < 0 ? -1 : 0,
                playerKey: String(r.player.id),
                name:      r.player?.name              || '',
                country:   r.player?.country?.name     || r.player?.countryAcr || '',
                birthday:  r.player?.birthday          || null,
                points:    r.point                     || 0,
                tour,
            }))
            .sort((a, b) => a.rank - b.rank);

        await cache.set(env, TTL.standings, data, 'standings2', tour);
        return data;
    } catch (err) {
        const stale = await cache.getStale(env, 'standings2', tour);
        if (stale) return stale.data;
        throw err;
    }
}
