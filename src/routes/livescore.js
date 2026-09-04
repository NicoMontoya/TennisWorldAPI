import { cache }               from '../cache.js';
import { apiTennis, rapidAPI } from '../apiClient.js';
import { transformLivescore }  from '../transforms/index.js';
import { TTL, EVENT_TYPES }    from '../config.js';
import { parseTour, parseTournamentKey, rateLimit } from '../security.js';

const ROUND_NAME = {
    12: 'Final',       10: 'Semi-finals',    9: 'Quarter-finals',
    7:  'Round of 16', 6:  'Round of 32',    5: 'Round of 64',
    4:  'Round of 128', 8: 'Round Robin',
};

const TIER_ORDER = {
    'Grand Slam': 1, 'ATP Masters 1000': 2, 'WTA 1000': 2,
    'ATP 500': 3, 'WTA 500': 3, 'ATP 250': 4, 'WTA 250': 4,
};
function tierPriority(tier) {
    if (!tier) return 99;
    for (const [key, val] of Object.entries(TIER_ORDER)) {
        if (tier.includes(key)) return val;
    }
    return 9;
}
const MAIN_TIERS = Object.keys(TIER_ORDER);
function isMainTour(tier) {
    return !!tier && MAIN_TIERS.some(t => tier.includes(t));
}

// GET /api/livescore?tour=ATP|WTA&tournamentKey=123
// Rate limit is on top of the existing cache TTL / freshness (not a replacement).
export async function handleLivescore(request, env) {
    await rateLimit(env, request, 'livescore');

    const { searchParams } = new URL(request.url);
    const tour          = parseTour(searchParams.get('tour'));
    const tournamentKey = parseTournamentKey(searchParams.get('tournamentKey'));

    const cacheKey = ['livescore2', tour, tournamentKey || 'all'];

    const cached = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    const now      = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // ── 1. Try old API (api-tennis.com) for true real-time livescores ─────────
    let data = [];
    try {
        const opts = {
            event_type_key: EVENT_TYPES[tour],
            ...(tournamentKey && { tournament_key: tournamentKey }),
        };
        const raw = await apiTennis.livescore(env, opts);
        data = transformLivescore(raw);
    } catch (_) { /* fall through to supplement */ }

    // ── 2. If old API returned nothing, supplement with today's fixtures ──────
    // This shows scheduled matches for the active tournament so the ticker
    // and live grid are populated even when the old API has no live data.
    if (!data || data.length === 0) {
        try {
            const year    = now.getFullYear();
            const calData = await rapidAPI.calendar(env, tour, year);
            const items   = calData?.data || [];

            const active  = items
                .filter(t => {
                    if (!isMainTour(t.tier) || !t.date) return false;
                    const daysSince = (now - new Date(t.date)) / 86_400_000;
                    return daysSince >= -1 && daysSince < 21;
                })
                .sort((a, b) => tierPriority(a.tier) - tierPriority(b.tier));

            if (active.length > 0) {
                const best = active[0];
                const tid  = String(best.id);

                const [fixturesRes, resultsRes] = await Promise.allSettled([
                    rapidAPI.tournamentFixtures(env, tour, tid),
                    rapidAPI.tournamentResults(env, tour, tid),
                ]);

                const fixtures = fixturesRes.status === 'fulfilled'
                    ? (fixturesRes.value?.data || []) : [];
                const results  = resultsRes.status === 'fulfilled'
                    ? (resultsRes.value?.data?.singles || []) : [];

                // Fixtures scheduled for today (or with no date = treat as today)
                const todayFixtures = fixtures.filter(f =>
                    !f.date || f.date.startsWith(todayStr)
                );

                // Build seed map from fixtures
                const seedMap = new Map();
                for (const f of fixtures) {
                    if (f.seed1 && f.player1Id) seedMap.set(f.player1Id, parseInt(f.seed1));
                    if (f.seed2 && f.player2Id) seedMap.set(f.player2Id, parseInt(f.seed2));
                }

                // Today's completed results
                const completedToday = results.filter(r => r.date && r.date.startsWith(todayStr));

                data = [
                    ...todayFixtures.map(f => ({
                        matchKey:     String(f.id),
                        player1Name:  f.player1?.name || '',
                        player1Key:   String(f.player1Id || ''),
                        player2Name:  f.player2?.name || '',
                        player2Key:   String(f.player2Id || ''),
                        isLive:       false,
                        status:       'Not Started',
                        setScores:    [],
                        round:        ROUND_NAME[f.roundId] || `Round ${f.roundId}`,
                        roundId:      f.roundId,
                        tournamentKey: tid,
                        tournamentName: best.name || '',
                        player1Seed:  seedMap.get(f.player1Id) || null,
                        player2Seed:  seedMap.get(f.player2Id) || null,
                        date:         f.date || todayStr,
                    })),
                    ...completedToday.map(r => {
                        const p1Id   = r.player1Id;
                        const p2Id   = r.player2Id;
                        const won    = r.match_winner;
                        const winner = won ? (won === p1Id ? 'player1' : 'player2') : null;
                        return {
                            matchKey:     String(r.id),
                            player1Name:  r.player1?.name || '',
                            player1Key:   String(p1Id || ''),
                            player2Name:  r.player2?.name || '',
                            player2Key:   String(p2Id || ''),
                            winner,
                            isLive:       false,
                            status:       'Finished',
                            setScores:    (r.result || '').trim().split(/\s+/).filter(Boolean),
                            round:        ROUND_NAME[r.roundId] || `Round ${r.roundId}`,
                            roundId:      r.roundId,
                            tournamentKey: tid,
                            tournamentName: best.name || '',
                            player1Seed:  seedMap.get(p1Id) || null,
                            player2Seed:  seedMap.get(p2Id) || null,
                            date:         r.date || todayStr,
                        };
                    }),
                ];
            }
        } catch (_) { /* best-effort supplement */ }
    }

    // Short cache: 60s when we have live matches, 2min otherwise
    const hasLive = data.some(m => m.isLive);
    await cache.set(env, hasLive ? TTL.livescore : 120, data, ...cacheKey);
    return data;
}
