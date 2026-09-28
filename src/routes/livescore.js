import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL }      from '../config.js';
import { getCalendarYear } from '../calendarYear.js';
import { LIVESCORE_FETCHED_AT_UNKNOWN, normalizeFetchedAt, stampFetchedAt } from '../fetchedAt.js';
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
    dedupeBoardByPair,
    applyStickyCompletions,
    markPastStartUnplayed,
    snapshotSeenLive,
    mergeSeenSnapshots,
    completedSetChanged,
    stripStickyFlag,
} from '../transforms/matchstatLive.js';
import { assignEventType } from '../transforms/eventType.js';

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

function mapFixtureRow(f, { tid, tournamentName, seedMap, todayStr, tour }) {
    const player1Name = f.player1?.name || '';
    const player2Name = f.player2?.name || '';
    return assignEventType({
        matchKey:       String(f.id),
        player1Name,
        player1Key:     String(f.player1Id || ''),
        player2Name,
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
    }, {
        raw: f.eventType || f.event_type || f.event_type_type || f.tourType,
        tour,
        doubles: false,
        player1Name,
        player2Name,
    });
}

function mapResultRow(r, { tid, tournamentName, seedMap, todayStr, tour }) {
    const p1Id = r.player1Id;
    const p2Id = r.player2Id;
    const won  = r.match_winner;
    const winner = won ? (won === p1Id ? 'player1' : 'player2') : null;
    const player1Name = r.player1?.name || '';
    const player2Name = r.player2?.name || '';
    return assignEventType({
        matchKey:       String(r.id),
        player1Name,
        player1Key:     String(p1Id || ''),
        player2Name,
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
    }, {
        raw: r.eventType || r.event_type || r.event_type_type || r.tourType,
        tour,
        bucket: 'singles',
        doubles: false,
        player1Name,
        player2Name,
    });
}

async function loadCalendar(env, tour, now) {
    const year = now.getFullYear();
    const years = now.getMonth() === 0 ? [year - 1, year] : [year];
    const pages = await Promise.all(years.map(y => getCalendarYear(env, tour, y, now)));
    const items = [];
    for (const p of pages) items.push(...(p?.data || []));
    return items;
}

// GET /api/livescore?tour=ATP|WTA&tournamentKey=123
// PUBLIC_GET (auth: false) — Scores ticker. No session / Authorization.
// Rate limit (Cache API, fail-closed 429) is on top of cache TTL, not a replacement.
// Live source is MatchStat Extend events/live (env.RAPIDAPI_KEY only).
// Core fixtures/results fill Not Started / Finished — they never set isLive.
// Same-pair results drop stale fixtures (fixture id ≠ result id).
// InPlay that vanishes from Extend stays Finished with last scores (sticky)
// until Core results confirm. Past-start unplayed → Delayed, no invented scores.
// Response is the existing fixtures-board shape (string[] setScores) plus
// currentGame when InPlay. 60s TTL when InPlay, scheduled, or delayed;
// idle 2 min only when the board is finished-only / empty.
// The live payload is edge-cached. A successful fill also writes one
// no-expiry KV stale copy so an outage or hard stop can serve that board.
// The primary KV key is not written. Sticky-completion `:done` still uses
// KV when the completed-match set changes.
export async function handleLivescore(request, env) {
    await rateLimit(env, request, 'livescore');

    const { searchParams } = new URL(request.url);
    const tour          = parseTour(searchParams.get('tour'));
    const tournamentKey = parseTournamentKey(searchParams.get('tournamentKey'));

    const cacheKey = ['livescore3', tour, tournamentKey || 'all'];

    const cached = await cache.get(env, ...cacheKey);
    if (cached && Array.isArray(cached.data)) {
        // Edge hit (and a KV primary, if one exists) keeps the original
        // upstream time. cachedAt is only a stand-in for entries written
        // before fetchedAt was stored.
        const at = normalizeFetchedAt(cached.fetchedAt || cached.cachedAt);
        return stampFetchedAt(cached.data, at);
    }

    const now      = new Date();
    const todayStr = now.toISOString().split('T')[0];
    // Worker clock at the first successful upstream response in this fill.
    let fetchedAt = null;
    const markFetched = () => {
        if (!fetchedAt) fetchedAt = new Date().toISOString();
    };

    let liveRaw = [];
    try {
        liveRaw = await rapidAPI.liveEvents(env);
        // Missing key returns [] without a paid call. A hard stop throws.
        if (env?.RAPIDAPI_KEY) markFetched();
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
        if (fx.status === 'fulfilled' || rs.status === 'fulfilled') markFetched();
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
                tour,
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
        const todayFxKeys = new Set(
            todayFixtures.map(f => pairRoundKey(f.player1Id, f.player2Id, f.roundId, tid)).filter(Boolean),
        );
        // Include today's results, plus any result that covers a today's fixture
        // (result date can lag or sit in a different id namespace).
        const relevantResults = results.filter(r => {
            if (r.date && String(r.date).startsWith(todayStr)) return true;
            const pk = pairRoundKey(r.player1Id, r.player2Id, r.roundId, tid);
            return pk && todayFxKeys.has(pk);
        });
        const ctx = { tid, tournamentName, seedMap, todayStr, tour };
        board.push(
            ...todayFixtures.map(f => mapFixtureRow(f, ctx)),
            ...relevantResults.map(r => mapResultRow(r, ctx)),
        );
    }

    let data = dedupeBoardByPair(board);
    data = mergeLiveOverBoard(data, liveRows);
    const seenKey = tournamentKey || 'all';
    const prevSeen = await loadSeenLive(env, tour, seenKey);
    data = applyStickyCompletions(data, prevSeen, liveRows);
    data = markPastStartUnplayed(data, now);
    const snapshot = snapshotSeenLive(data);
    await persistSeenLive(env, tour, seenKey, snapshot, prevSeen);
    data = data.map(stripStickyFlag);

    // A successful upstream fill remembers its clock time on the edge entry,
    // a no-expiry KV stale copy, and a long-lived edge marker. Failures do
    // not invent a new time.
    if (fetchedAt) {
        try {
            await cache.setEdge(livescoreTtlFor(data), data, ...cacheKey, { fetchedAt });
        } catch { /* edge put is already fail-soft */ }
        try {
            await cache.setStale(env, data, ...cacheKey, { fetchedAt });
        } catch { /* KV stale is best-effort */ }
        try {
            await cache.setEdge(LIVESCORE_FETCHED_AT_MARKER_TTL, fetchedAt, ...cacheKey, 'fetched-at');
        } catch { /* marker is best-effort */ }
        return stampFetchedAt(data, fetchedAt);
    }

    return serveLivescoreFallback(env, cacheKey);
}

// No successful upstream response this request. Serve the KV stale board
// when we have one; otherwise the empty board with the last known fetch
// time, or the epoch when nothing was ever fetched.
async function serveLivescoreFallback(env, cacheKey) {
    const stale = await cache.getStale(env, ...cacheKey);
    if (stale && Array.isArray(stale.data)) {
        const at = normalizeFetchedAt(stale.fetchedAt || stale.cachedAt);
        try {
            await cache.setEdge(livescoreTtlFor(stale.data), stale.data, ...cacheKey, { fetchedAt: at });
        } catch { /* next miss can read KV again */ }
        return stampFetchedAt(stale.data, at);
    }

    let known = null;
    try {
        const marker = await cache.getEdge(...cacheKey, 'fetched-at');
        if (typeof marker?.data === 'string') known = marker.data;
    } catch { /* treat as unknown */ }
    const at = normalizeFetchedAt(known || LIVESCORE_FETCHED_AT_UNKNOWN);
    const empty = [];
    try {
        await cache.setEdge(TTL.livescoreIdle, empty, ...cacheKey, { fetchedAt: at });
    } catch { /* header is still set on this response */ }
    return stampFetchedAt(empty, at);
}

const LIVESCORE_FETCHED_AT_MARKER_TTL = 31 * 24 * 60 * 60;

/** 60s while anything is live, scheduled, or delayed; 120s only when nothing can go InPlay. */
export function livescoreTtlFor(board) {
    const rows = Array.isArray(board) ? board : [];
    const watchForLive = rows.some(m =>
        m.isLive || m.status === 'Not Started' || m.status === 'Delayed',
    );
    return watchForLive ? TTL.livescore : TTL.livescoreIdle;
}

export async function loadSeenLive(env, tour, tournamentKey) {
    try {
        const tk = tournamentKey || 'all';
        const seen = await cache.get(env, 'livescore3', tour, tk, 'seen');
        const done = await cache.get(env, 'livescore3', tour, tk, 'done');
        return mergeSeenSnapshots(seen?.data, done?.data);
    } catch {
        return [];
    }
}

/** Edge snapshot every fill (free). KV only when the completed-match set changes. */
export async function persistSeenLive(env, tour, tournamentKey, snapshot, previous) {
    const tk = tournamentKey || 'all';
    try {
        await cache.setEdge(TTL.livescoreSeen, snapshot, 'livescore3', tour, tk, 'seen');
    } catch { /* edge put is already fail-soft */ }

    const nextDone = (snapshot || []).filter(s => s.stickyComplete);
    const prevDone = (previous || []).filter(s => s.stickyComplete);
    if (!completedSetChanged(prevDone, nextDone)) return;
    await cache.set(
        env,
        TTL.livescoreSeen,
        nextDone,
        'livescore3',
        tour,
        tk,
        'done',
        { skipStale: true },
    );
}
