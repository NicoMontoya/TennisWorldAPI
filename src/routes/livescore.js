import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL }      from '../config.js';
import { parseTour, parseTournamentKey, rateLimit } from '../security.js';
import {
    ROUND_NAME,
    isMainTourTier,
    tierPriority,
    parseMatchId,
    filterLiveEvents,
    indexCoreMatches,
    mapLiveEvent,
    mergeLiveOverBoard,
    pairRoundKey,
} from '../transforms/matchstatLive.js';

function pickBestActive(items, now) {
    return (items || [])
        .filter(t => {
            if (!isMainTourTier(t.tier) || !t.date) return false;
            const daysSince = (now - new Date(t.date)) / 86_400_000;
            return daysSince >= -1 && daysSince < 21;
        })
        .sort((a, b) => {
            const tp = tierPriority(a.tier) - tierPriority(b.tier);
            if (tp !== 0) return tp;
            return (b.date || '').localeCompare(a.date || '');
        })[0] || null;
}

function isSingles(m) {
    return !m?.player1?.name?.includes('/') && !m?.player2?.name?.includes('/');
}

function seedMapFrom(fixtures) {
    const seedMap = new Map();
    for (const f of fixtures || []) {
        if (f.seed1 && f.player1Id) seedMap.set(f.player1Id, parseInt(f.seed1, 10));
        if (f.seed2 && f.player2Id) seedMap.set(f.player2Id, parseInt(f.seed2, 10));
    }
    return seedMap;
}

function mapFixtureRow(f, { tid, tournamentName, seedMap, todayStr }) {
    return {
        matchKey:       String(f.id),
        player1Name:    f.player1?.name || '',
        player1Key:     String(f.player1Id || ''),
        player2Name:    f.player2?.name || '',
        player2Key:     String(f.player2Id || ''),
        isLive:         false,
        status:         'Not Started',
        setScores:      [],
        currentGame:    null,
        round:          ROUND_NAME[f.roundId] || `Round ${f.roundId}`,
        roundId:        f.roundId,
        tournamentKey:  tid,
        tournamentName: tournamentName || '',
        player1Seed:    seedMap.get(f.player1Id) || null,
        player2Seed:    seedMap.get(f.player2Id) || null,
        date:           f.date || todayStr,
    };
}

function mapResultRow(r, { tid, tournamentName, seedMap, todayStr }) {
    const p1Id = r.player1Id;
    const p2Id = r.player2Id;
    const won  = r.match_winner;
    const winner = won ? (won === p1Id ? 'player1' : 'player2') : null;
    return {
        matchKey:       String(r.id),
        player1Name:    r.player1?.name || '',
        player1Key:     String(p1Id || ''),
        player2Name:    r.player2?.name || '',
        player2Key:     String(p2Id || ''),
        winner,
        isLive:         false,
        status:         'Finished',
        setScores:      (r.result || '').trim().split(/\s+/).filter(Boolean),
        currentGame:    null,
        round:          ROUND_NAME[r.roundId] || `Round ${r.roundId}`,
        roundId:        r.roundId,
        tournamentKey:  tid,
        tournamentName: tournamentName || '',
        player1Seed:    seedMap.get(p1Id) || null,
        player2Seed:    seedMap.get(p2Id) || null,
        date:           r.date || todayStr,
    };
}

async function loadCalendar(env, tour, now) {
    const year = now.getFullYear();
    const years = now.getMonth() === 0 ? [year - 1, year] : [year];
    const pages = await Promise.all(years.map(y => rapidAPI.calendar(env, tour, y)));
    const items = [];
    for (const p of pages) items.push(...(p?.data || []));
    return items;
}

// GET /api/livescore?tour=ATP|WTA&tournamentKey=123
// PUBLIC_GET (auth: false) — Scores ticker. No session / Authorization.
// Rate limit (Cache API, fail-closed 429) is on top of cache TTL, not a replacement.
// Live source is MatchStat Extend events/live (env.RAPIDAPI_KEY only).
// Core fixtures/results fill Not Started / Finished — they never set isLive.
// Response is the existing fixtures-board shape (string[] setScores) plus
// currentGame when InPlay. Live TTL 30s / idle 2 min; skipStale.
export async function handleLivescore(request, env) {
    await rateLimit(env, request, 'livescore');

    const { searchParams } = new URL(request.url);
    const tour          = parseTour(searchParams.get('tour'));
    const tournamentKey = parseTournamentKey(searchParams.get('tournamentKey'));

    const cacheKey = ['livescore3', tour, tournamentKey || 'all'];

    const cached = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    const now      = new Date();
    const todayStr = now.toISOString().split('T')[0];

    let liveRaw = [];
    try {
        liveRaw = await rapidAPI.liveEvents(env);
    } catch {
        liveRaw = [];
    }

    let calendarItems = [];
    if (!tournamentKey) {
        try {
            calendarItems = await loadCalendar(env, tour, now);
        } catch {
            calendarItems = [];
        }
    }

    const calendarById = new Map(
        calendarItems.map(t => [String(t.id), t]),
    );

    const liveFiltered = filterLiveEvents(liveRaw, { tour, tournamentKey, calendarById });

    const best = tournamentKey
        ? (calendarById.get(String(tournamentKey)) || { id: tournamentKey })
        : pickBestActive(calendarItems, now);

    const tids = new Set();
    if (tournamentKey) {
        tids.add(String(tournamentKey));
    } else if (best) {
        tids.add(String(best.id));
    }
    for (const ev of liveFiltered) {
        const parsed = parseMatchId(ev.matchId);
        if (parsed) tids.add(parsed.tournamentId);
    }

    const fixturesByTid = new Map();
    const resultsByTid  = new Map();
    await Promise.all([...tids].map(async tid => {
        const [fx, rs] = await Promise.allSettled([
            rapidAPI.tournamentFixtures(env, tour, tid),
            rapidAPI.tournamentResults(env, tour, tid),
        ]);
        fixturesByTid.set(tid, fx.status === 'fulfilled' ? (fx.value?.data || []) : []);
        resultsByTid.set(tid, rs.status === 'fulfilled' ? (rs.value?.data?.singles || []) : []);
    }));

    const coreIndex = indexCoreMatches(fixturesByTid, resultsByTid);
    const liveRows = liveFiltered
        .map(ev => {
            const parsed = parseMatchId(ev.matchId);
            const core = parsed
                ? coreIndex.get(pairRoundKey(parsed.player1Id, parsed.player2Id, parsed.roundId, parsed.tournamentId))
                : null;
            const cal = parsed ? calendarById.get(parsed.tournamentId) : null;
            return mapLiveEvent(ev, core, {
                todayStr,
                tournamentName: ev.league || cal?.name || best?.name || '',
            });
        })
        .filter(Boolean);

    const boardTids = tournamentKey
        ? [String(tournamentKey)]
        : (best ? [String(best.id)] : []);

    const board = [];
    for (const tid of boardTids) {
        const fixtures = (fixturesByTid.get(tid) || []).filter(isSingles);
        const results  = (resultsByTid.get(tid) || []).filter(isSingles);
        const seedMap  = seedMapFrom(fixtures);
        const cal      = calendarById.get(tid);
        const tournamentName = cal?.name || best?.name || '';
        const todayFixtures = fixtures.filter(f => !f.date || String(f.date).startsWith(todayStr));
        const completedToday = results.filter(r => r.date && String(r.date).startsWith(todayStr));
        const ctx = { tid, tournamentName, seedMap, todayStr };
        board.push(
            ...todayFixtures.map(f => mapFixtureRow(f, ctx)),
            ...completedToday.map(r => mapResultRow(r, ctx)),
        );
    }

    const data = mergeLiveOverBoard(board, liveRows);

    const hasLive = data.some(m => m.isLive);
    await cache.set(
        env,
        hasLive ? TTL.livescore : TTL.livescoreIdle,
        data,
        ...cacheKey,
        { skipStale: true },
    );
    return data;
}
