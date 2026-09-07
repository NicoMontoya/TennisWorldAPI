import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL }      from '../config.js';
import { parseTour, rateLimit } from '../security.js';
import {
    filterLiveEvents,
    parseMatchId,
    mapLiveEvent,
    pairRoundKey,
    indexCoreMatches,
    applyLiveOverlayToHub,
} from '../transforms/matchstatLive.js';

// roundId → display name
const ROUND_NAME = {
    12: 'Final',
    10: 'Semi-finals',
    9:  'Quarter-finals',
    7:  'Round of 16',
    6:  'Round of 32',
    5:  'Round of 64',
    4:  'Round of 128',
    8:  'Round Robin',
    11: 'Bronze Play-off',
};

// Higher weight = later / more important round
const ROUND_WEIGHT = {
    12: 10, 11: 9.5, 10: 9, 9: 8, 7: 7, 8: 6.5, 6: 6, 5: 5, 4: 4,
};

const TIER_PRIORITY = {
    'Grand Slam': 1,
    'ATP Masters 1000': 2, 'WTA 1000': 2,
    'ATP 500': 3,          'WTA 500': 3,
    'ATP 250': 4,          'WTA 250': 4,
    'Finals': 4,
};
function tierPriority(tier) {
    if (!tier) return 99;
    for (const [key, val] of Object.entries(TIER_PRIORITY)) {
        if (tier.includes(key)) return val;
    }
    return 9;
}

const MAIN_TOUR_TIERS = ['Grand Slam', 'ATP Masters 1000', 'WTA 1000', 'ATP 500', 'WTA 500', 'ATP 250', 'WTA 250', 'Finals'];
function isMainTour(tier) {
    if (!tier) return false;
    return MAIN_TOUR_TIERS.some(t => tier.includes(t));
}

function parseScore(result) {
    if (!result) return [];
    return result.trim().split(/\s+/);
}

// GET /api/hub?tour=ATP|WTA
// Rate limit (Cache API) is on top of TTL.hub (5 min), not a replacement.
export async function handleHub(request, env) {
    await rateLimit(env, request, 'hub');

    const { searchParams } = new URL(request.url);
    const tour = parseTour(searchParams.get('tour'));

    const cacheKey = ['hub3', tour];
    const cached = await cache.get(env, ...cacheKey);
    if (cached) return overlayHubFromLivescoreCache(env, tour, cached.data);

    // 1. Fetch this year's calendar (and previous if we're in Jan)
    const now  = new Date();
    const year = now.getFullYear();
    let calendarItems = [];
    try {
        const years = year === now.getFullYear() && now.getMonth() === 0
            ? [year - 1, year]
            : [year];
        const pages = await Promise.all(years.map(y => rapidAPI.calendar(env, tour, y)));
        for (const p of pages) {
            const items = p?.data || (Array.isArray(p) ? p : []);
            calendarItems = calendarItems.concat(items);
        }
    } catch (err) {
        const stale = await cache.getStale(env, ...cacheKey);
        if (stale) return overlayHubFromLivescoreCache(env, tour, stale.data);
        throw err;
    }

    // Find active tournaments: main tour, started within last 21 days (or starts within 1 day)
    const active = calendarItems.filter(t => {
        if (!t.date || !isMainTour(t.tier)) return false;
        const start = new Date(t.date);
        const daysSince = (now - start) / 86_400_000;
        return daysSince >= -1 && daysSince < 21;
    }).sort((a, b) => {
        const tp = tierPriority(a.tier) - tierPriority(b.tier);
        if (tp !== 0) return tp;
        return (b.date || '').localeCompare(a.date || '');
    });

    if (!active.length) {
        return { tournament: null, featuredMatch: null, h2h: null };
    }

    const best = active[0];
    const tournamentId = String(best.id);

    // 2. Fetch draws data (results + fixtures) for this tournament
    let resultsData, fixturesData;
    try {
        [resultsData, fixturesData] = await Promise.all([
            rapidAPI.tournamentResults(env, tour, tournamentId),
            rapidAPI.tournamentFixtures(env, tour, tournamentId),
        ]);
    } catch (err) {
        const stale = await cache.getStale(env, ...cacheKey);
        if (stale) return overlayHubFromLivescoreCache(env, tour, stale.data);
        throw err;
    }

    const completedRaw = resultsData?.data?.singles || [];
    const upcomingRaw  = fixturesData?.data         || [];

    // Build seed map from fixtures
    const seedMap = new Map();
    for (const f of upcomingRaw) {
        if (f.seed1 && f.player1Id) seedMap.set(f.player1Id, parseInt(f.seed1));
        if (f.seed2 && f.player2Id) seedMap.set(f.player2Id, parseInt(f.seed2));
    }

    function transform(m, status) {
        const p1Id  = m.player1Id;
        const p2Id  = m.player2Id;
        const won   = m.match_winner;
        const winner = won ? (won === p1Id ? 'player1' : 'player2') : null;
        return {
            matchKey:    String(m.id),
            player1Name: m.player1?.name  || '',
            player1Key:  String(p1Id      || ''),
            player2Name: m.player2?.name  || '',
            player2Key:  String(p2Id      || ''),
            winner,
            setScores:   parseScore(m.result),
            round:       ROUND_NAME[m.roundId] || `Round ${m.roundId}`,
            roundId:     m.roundId,
            status,
            isLive:      false,
            currentGame: null,
            date:        m.date || null,
            player1Seed: seedMap.get(p1Id) || null,
            player2Seed: seedMap.get(p2Id) || null,
        };
    }

    const completed = completedRaw.map(m => transform(m, 'Finished'));
    const upcoming  = upcomingRaw.map(m  => transform(m, 'Not Started'));

    // Sort each group by round importance (highest first)
    const byWeight = (a, b) => (ROUND_WEIGHT[b.roundId] || 0) - (ROUND_WEIGHT[a.roundId] || 0);
    upcoming.sort(byWeight);
    completed.sort((a, b) => byWeight(a, b) || (b.date || '').localeCompare(a.date || ''));

    // Featured: prefer highest-round upcoming, fall back to most recently completed.
    // Live overlay below may promote an InPlay today's match.
    let featuredMatch = upcoming[0] || completed[0] || null;

    // Recent results for the ticker/latest strip (up to 10)
    const recentResults = completed.slice(0, 10);

    // All of today's matches — completed + scheduled fixtures
    // Sort: completed (finished today) first by round weight, then upcoming sorted earliest round first
    const todayStr = now.toISOString().split('T')[0];
    const completedToday = completed.filter(m => m.date && m.date.startsWith(todayStr));
    // Fixtures don't always carry a date — include all when no date, or filter to today
    const upcomingToday  = upcoming.filter(m => !m.date || m.date.startsWith(todayStr));
    let todaysMatches  = [...upcomingToday, ...completedToday];

    // Overlay MatchStat InPlay onto today's rows + featured so first paint
    // has isLive / setScores / currentGame without a client-side livescore merge.
    let liveRows = [];
    try {
        liveRows = await loadHubLiveRows(env, tour, {
            fixtures: upcomingRaw,
            results: completedRaw,
            tournamentId,
            calendarItems,
            todayStr,
        });
    } catch { /* fail-soft — hub still returns Core fixtures */ }

    const withLive = applyLiveOverlayToHub(
        { featuredMatch, todaysMatches },
        liveRows,
    );
    featuredMatch = withLive.featuredMatch;
    todaysMatches = withLive.todaysMatches;

    // 3. Fetch H2H for the featured match (best-effort)
    let h2h = null;
    if (featuredMatch?.player1Key && featuredMatch?.player2Key) {
        try {
            const raw = await rapidAPI.h2h(env, tour, featuredMatch.player1Key, featuredMatch.player2Key);
            const bySurface = (raw?.data || []).map(s => ({
                surface: s.court || '',
                p1Wins:  Number(s.player1wins) || 0,
                p2Wins:  Number(s.player2wins) || 0,
            }));
            const p1Total = bySurface.reduce((n, s) => n + s.p1Wins, 0);
            const p2Total = bySurface.reduce((n, s) => n + s.p2Wins, 0);
            h2h = {
                totalMatches: p1Total + p2Total,
                p1Wins: p1Total,
                p2Wins: p2Total,
                bySurface,
            };
        } catch (_) { /* H2H is best-effort */ }
    }

    const result = {
        tournament: {
            key:  tournamentId,
            name: best.name || '',
            tier: best.tier || '',
        },
        featuredMatch,
        recentResults,
        todaysMatches,
        h2h,
    };

    // 5-minute cache — short enough to catch new results during an active day.
    // Live scores on a cache hit are refreshed from the livescore KV entry
    // (no extra hub write) so first paint tracks MatchStat InPlay.
    await cache.set(env, TTL.hub, result, ...cacheKey);
    return result;
}

async function overlayHubFromLivescoreCache(env, tour, hubData) {
    try {
        const liveCached = await cache.get(env, 'livescore3', tour, 'all');
        const liveRows = (liveCached?.data || []).filter(m => m && m.isLive);
        if (!liveRows.length) return hubData;
        return applyLiveOverlayToHub(hubData, liveRows);
    } catch {
        return hubData;
    }
}

async function loadHubLiveRows(env, tour, { fixtures, results, tournamentId, calendarItems, todayStr }) {
    let liveRaw = [];
    try {
        liveRaw = await rapidAPI.liveEvents(env);
    } catch {
        return [];
    }
    const calendarById = new Map((calendarItems || []).map(t => [String(t.id), t]));
    const liveFiltered = filterLiveEvents(liveRaw, {
        tour,
        tournamentKey: tournamentId,
        calendarById,
    });
    const coreIndex = indexCoreMatches(
        new Map([[tournamentId, fixtures || []]]),
        new Map([[tournamentId, results || []]]),
    );
    return liveFiltered
        .map(ev => {
            const parsed = parseMatchId(ev.matchId);
            const core = parsed
                ? coreIndex.get(pairRoundKey(parsed.player1Id, parsed.player2Id, parsed.roundId, parsed.tournamentId))
                : null;
            return mapLiveEvent(ev, core, { todayStr, tournamentName: ev.league || '' });
        })
        .filter(Boolean);
}
