import { cache }             from '../cache.js';
import { db }                from '../db.js';
import { apiTennis }         from '../apiClient.js';
import { transformStandings, transformPlayer } from '../transforms/index.js';
import { TTL }               from '../config.js';

// ── Surface stats helpers ─────────────────────────────────────────────────────

// surface = 'hard' | 'clay' | 'grass'
// profile.seasons entries have: { year, hardW, hardL, clayW, clayL, grassW, grassL }
function extractSurfaceStats(profile, surface) {
    if (!profile || !profile.seasons || !profile.seasons.length) {
        return { wins: 0, losses: 0, winPct: 0, matchesPlayed: 0 };
    }

    // Aggregate across the two most recent seasons for a stable sample size
    const sorted  = [...profile.seasons].sort((a, b) => Number(b.year) - Number(a.year));
    const recent  = sorted.slice(0, 2);

    const wKey = `${surface}W`;   // e.g. 'hardW'
    const lKey = `${surface}L`;   // e.g. 'hardL'

    const wins   = recent.reduce((sum, s) => sum + (s[wKey] || 0), 0);
    const losses = recent.reduce((sum, s) => sum + (s[lKey] || 0), 0);
    const total  = wins + losses;

    return {
        wins,
        losses,
        winPct:        total > 0 ? Math.round((wins / total) * 100) : 0,
        matchesPlayed: total,
    };
}

// Fetch a single player profile — returns null on failure so we never crash
async function fetchProfile(env, playerKey) {
    try {
        // 1. Cache
        const cached = await cache.get(env, 'player', playerKey);
        if (cached) return cached.data;

        // 2. DB stub
        const fromDB = await db.getPlayer(env, playerKey);
        if (fromDB) {
            await cache.set(env, TTL.players, fromDB, 'player', playerKey);
            return fromDB;
        }

        // 3. API
        const raw  = await apiTennis.player(env, playerKey);
        const data = transformPlayer(raw);
        if (data) await cache.set(env, TTL.players, data, 'player', playerKey);
        return data;
    } catch {
        return null;
    }
}

// ── Route handler ─────────────────────────────────────────────────────────────
// GET /api/surface-standings?tour=ATP|WTA&surface=hard|clay|grass

export async function handleSurfaceStandings(request, env) {
    const { searchParams } = new URL(request.url);
    const tour    = (searchParams.get('tour')    || 'ATP').toUpperCase();
    const surface = (searchParams.get('surface') || 'hard').toLowerCase();

    if (!['hard', 'clay', 'grass'].includes(surface)) {
        throw new Error(`Invalid surface: ${surface}. Use hard, clay, or grass.`);
    }

    // Cache the computed surface ranking separately from individual player caches
    const cacheKey = ['surface-standings', tour, surface];
    const cached = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    // 1. Get overall standings (will hit its own cache)
    const rawStandings = await apiTennis.standings(env, tour);
    const standings    = transformStandings(rawStandings);
    const top          = standings.slice(0, 25); // fetch profiles for top 25

    // 2. Batch-fetch player profiles in parallel (each cached independently at 72hr)
    const profiles = await Promise.all(top.map(p => fetchProfile(env, p.playerKey)));

    // 3. Combine standings + surface stats, drop players with no surface data
    const combined = top.map((p, i) => {
        const stats = extractSurfaceStats(profiles[i], surface);
        return {
            playerKey:      p.playerKey,
            name:           p.name,
            country:        p.country,
            atpRank:        p.rank,         // overall ATP rank
            atpPoints:      p.points,
            atpMovement:    p.movement,
            surface,
            wins:           stats.wins,
            losses:         stats.losses,
            winPct:         stats.winPct,
            matchesPlayed:  stats.matchesPlayed,
        };
    });

    // 4. Sort by win% desc, then by matches played desc as tiebreak
    combined.sort((a, b) =>
        b.winPct !== a.winPct
            ? b.winPct - a.winPct
            : b.matchesPlayed - a.matchesPlayed
    );

    // 5. Assign surface rank
    const result = combined.map((p, i) => ({ ...p, surfaceRank: i + 1 }));

    // Cache the final computed ranking for 24hr
    await cache.set(env, 24 * 60 * 60, result, ...cacheKey);

    return result;
}
