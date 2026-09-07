import { assignEventType } from './eventType.js';

// ===================================
// MatchStat (RapidAPI Extend) live mapping
// ===================================
// Normalizes GET /tennis/v2/extend/api/events/live into the Scores board shape.
// Core fixtures are UNPLAYED schedule only — they cannot mark isLive. Live
// scores come from Extend events; matchKey is a Core fixture/result id when
// we can resolve one, never the live event `id`.

export const ROUND_NAME = {
    12: 'Final',        10: 'Semi-finals',     9: 'Quarter-finals',
    7:  'Round of 16',  6:  'Round of 32',     5: 'Round of 64',
    4:  'Round of 128', 8:  'Round Robin',    11: 'Bronze Play-off',
};

export const MAIN_TOUR_TIERS = [
    'Grand Slam', 'ATP Masters 1000', 'WTA 1000',
    'ATP 500', 'WTA 500', 'ATP 250', 'WTA 250', 'Finals',
];

export const TIER_ORDER = {
    'Grand Slam': 1, 'ATP Masters 1000': 2, 'WTA 1000': 2,
    'ATP 500': 3, 'WTA 500': 3, 'ATP 250': 4, 'WTA 250': 4,
    'Finals': 4,
};

export function isMainTourTier(tier) {
    if (!tier) return false;
    return MAIN_TOUR_TIERS.some(t => String(tier).includes(t));
}

export function tierPriority(tier) {
    if (!tier) return 99;
    for (const [key, val] of Object.entries(TIER_ORDER)) {
        if (String(tier).includes(key)) return val;
    }
    return 9;
}

// matchId: {player1_id}-{player2_id}-{tournamentId}-{roundId}
export function parseMatchId(matchId) {
    if (matchId == null) return null;
    const parts = String(matchId).trim().split('-');
    if (parts.length !== 4) return null;
    const [p1, p2, tournamentId, roundRaw] = parts;
    if (![p1, p2, tournamentId, roundRaw].every(p => /^\d+$/.test(p))) return null;
    return {
        player1Id:    p1,
        player2Id:    p2,
        tournamentId,
        roundId:      Number(roundRaw),
    };
}

export function unwrapLiveEvents(json) {
    if (Array.isArray(json)) return json;
    // MatchStat Extend live: { success, results: [...], count }
    if (Array.isArray(json?.results)) return json.results;
    if (Array.isArray(json?.result)) return json.result;
    if (Array.isArray(json?.result?.events)) return json.result.events;
    if (Array.isArray(json?.data)) return json.data;
    if (Array.isArray(json?.data?.events)) return json.data.events;
    return [];
}

export function parseLiveScore(score) {
    if (score == null) return [];
    const raw = String(score).trim();
    if (!raw) return [];
    const comma = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (comma.length > 1) return comma;
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) return [raw];
    const sets = [];
    for (const tok of tokens) {
        if (tok.startsWith('(') && sets.length) {
            sets[sets.length - 1] += tok;
        } else {
            sets.push(tok);
        }
    }
    return sets;
}

export function parseCurrentGame(points) {
    if (points == null) return null;
    const s = String(points).trim();
    if (!s) return null;
    return s.replace(/\s*-\s*/, ' - ');
}

export function mapLiveStatus(status) {
    const s = String(status || '').toLowerCase().replace(/[\s_-]/g, '');
    if (s === 'inplay' || s === 'live' || s === 'inprogress') {
        return { isLive: true, status: 'Live' };
    }
    if (s === 'finished' || s === 'ended' || s === 'retired' || s === 'walkover') {
        return { isLive: false, status: 'Finished' };
    }
    if (s === 'upcoming' || s === 'notstarted' || s === 'scheduled') {
        return { isLive: false, status: 'Not Started' };
    }
    return { isLive: false, status: status || 'Not Started' };
}

export function isDoublesEvent(event) {
    const blob = [event?.participant1, event?.participant2, event?.name]
        .filter(Boolean).join(' ');
    return blob.includes('/');
}

export function isLowerTierNoise(event) {
    const blob = `${event?.tourType || ''} ${event?.league || ''}`;
    // ITF/Challenger plus common ITF league codes (M15/M25/W15/W25).
    return /itf|challenger|\b[MW]\s?(15|25)\b/i.test(blob);
}

export function liveEventMatchesTour(event, tour) {
    const raw = String(event?.tourType || '').trim();
    if (!raw) return false;
    if (/itf|challenger/i.test(raw)) return false;
    const t = raw.toLowerCase();
    const want = String(tour || '').toLowerCase();
    return t === want || t.startsWith(`${want} `) || t.startsWith(`${want}-`);
}

export function pairRoundKey(p1, p2, roundId, tournamentId) {
    const a = String(p1 || '');
    const b = String(p2 || '');
    if (!a || !b || roundId == null || roundId === '') return '';
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const tid = tournamentId != null && tournamentId !== '' ? String(tournamentId) : '';
    return `${lo}|${hi}|${roundId}|${tid}`;
}

/** Board / Core row → pair+round+tournament key (player order does not matter). */
export function rowPairKey(m) {
    if (!m) return '';
    return pairRoundKey(
        m.player1Key ?? m.player1Id,
        m.player2Key ?? m.player2Id,
        m.roundId,
        m.tournamentKey ?? m.tournamentId,
    );
}

export function keepLiveEventForScores(event, { tour, tournamentKey, calendarById } = {}) {
    if (!liveEventMatchesTour(event, tour)) return false;
    if (isLowerTierNoise(event)) return false;
    if (isDoublesEvent(event)) return false;
    const parsed = parseMatchId(event.matchId);
    if (!parsed) return false;
    if (tournamentKey && parsed.tournamentId !== String(tournamentKey)) return false;
    if (calendarById?.size) {
        const cal = calendarById.get(parsed.tournamentId);
        if (cal && !isMainTourTier(cal.tier)) return false;
    }
    return true;
}

export function filterLiveEvents(raw, opts = {}) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(ev => keepLiveEventForScores(ev, opts));
}

export function indexCoreMatches(fixturesByTid, resultsByTid) {
    const map = new Map();
    const add = (tid, m, overwrite) => {
        const key = pairRoundKey(m.player1Id, m.player2Id, m.roundId, tid);
        if (!key) return;
        if (overwrite || !map.has(key)) map.set(key, { ...m, tournamentId: String(tid) });
    };
    for (const [tid, list] of fixturesByTid || []) {
        for (const m of list || []) add(tid, m, false);
    }
    // Results overwrite fixtures: fixture id ≠ result id for the same pair.
    for (const [tid, list] of resultsByTid || []) {
        for (const m of list || []) add(tid, m, true);
    }
    return map;
}

function seedOf(core, playerId) {
    if (!core || playerId == null) return null;
    const id = Number(playerId);
    if (core.player1Id != null && Number(core.player1Id) === id && core.seed1) {
        return parseInt(core.seed1, 10) || null;
    }
    if (core.player2Id != null && Number(core.player2Id) === id && core.seed2) {
        return parseInt(core.seed2, 10) || null;
    }
    return null;
}

// Core fixture/result `id` wins. Fallback is the Core matchId composite.
// Never the live event `id`.
export function resolveMatchKey(event, coreMatch) {
    const parsed = parseMatchId(event?.matchId);
    if (coreMatch?.id != null && String(coreMatch.id) !== '') {
        const coreId = String(coreMatch.id);
        if (event?.id == null || coreId !== String(event.id)) return coreId;
    }
    if (parsed) {
        const composite = `${parsed.player1Id}-${parsed.player2Id}-${parsed.tournamentId}-${parsed.roundId}`;
        if (event?.id == null || composite !== String(event.id)) return composite;
    }
    return null;
}

export function mapLiveEvent(event, coreMatch, extras = {}) {
    const parsed = parseMatchId(event?.matchId);
    if (!parsed) return null;
    const matchKey = resolveMatchKey(event, coreMatch);
    if (!matchKey) return null;

    const { isLive, status } = mapLiveStatus(event.status);
    const date = event.startTimestamp
        ? new Date(Number(event.startTimestamp) * 1000).toISOString()
        : extras.todayStr || null;

    const player1Name = event.participant1 || coreMatch?.player1?.name || '';
    const player2Name = event.participant2 || coreMatch?.player2?.name || '';
    const rawType = event.tourType
        || event.eventType
        || event.event_type
        || event.event_type_type
        || coreMatch?.eventType
        || coreMatch?.event_type
        || coreMatch?.event_type_type;

    return assignEventType({
        matchKey,
        player1Name,
        player1Key:     parsed.player1Id,
        player2Name,
        player2Key:     parsed.player2Id,
        isLive,
        status,
        setScores:      parseLiveScore(event.score),
        currentGame:    isLive ? parseCurrentGame(event.points) : null,
        round:          ROUND_NAME[parsed.roundId] || `Round ${parsed.roundId}`,
        roundId:        parsed.roundId,
        tournamentKey:  parsed.tournamentId,
        tournamentName: event.league || extras.tournamentName || '',
        player1Seed:    seedOf(coreMatch, parsed.player1Id),
        player2Seed:    seedOf(coreMatch, parsed.player2Id),
        date,
    }, {
        raw: rawType,
        tour: extras.tour,
        doubles: isDoublesEvent(event),
        player1Name,
        player2Name,
    });
}

function isFinishedRow(m) {
    return !!m && !m.isLive && m.status === 'Finished';
}

function isActiveOverlay(m) {
    return !!m && (m.isLive || m.status === 'Live' || m.status === 'Finished' || m.status === 'Delayed');
}

export function mergeLiveOverBoard(board, liveRows) {
    const result = (board || []).map(m => ({ ...m }));
    const byKey  = new Map();
    const byPair = new Map();
    for (const m of result) {
        if (m.matchKey) byKey.set(String(m.matchKey), m);
        const pk = rowPairKey(m);
        if (pk) byPair.set(pk, m);
    }

    const extras = [];
    for (const live of liveRows || []) {
        const hit = (live.matchKey && byKey.get(String(live.matchKey)))
            || byPair.get(rowPairKey(live));
        if (hit) {
            // Results/sticky Finished must not snap back to Upcoming/Not Started.
            if (isFinishedRow(hit) && !isActiveOverlay(live)) continue;
            hit.isLive      = live.isLive;
            hit.status      = live.status;
            hit.setScores   = live.setScores;
            hit.currentGame = live.currentGame;
            if (!hit.player1Name && live.player1Name) hit.player1Name = live.player1Name;
            if (!hit.player2Name && live.player2Name) hit.player2Name = live.player2Name;
            if (!hit.eventType && live.eventType) hit.eventType = live.eventType;
            if (!hit.tournamentName && live.tournamentName) hit.tournamentName = live.tournamentName;
        } else {
            extras.push(live);
        }
    }
    return [...extras, ...result];
}

function statusRank(m) {
    if (!m) return 0;
    if (m.isLive || m.status === 'Live') return 4;
    if (m.status === 'Finished') return 3;
    if (m.status === 'Delayed') return 2;
    if (m.status === 'Not Started') return 1;
    return 0;
}

function preferBoardRow(a, b) {
    const ra = statusRank(a);
    const rb = statusRank(b);
    if (rb !== ra) return rb > ra ? b : a;
    const sa = (a.setScores || []).length;
    const sb = (b.setScores || []).length;
    if (sb !== sa) return sb > sa ? b : a;
    if (b.winner && !a.winner) return b;
    if (a.winner && !b.winner) return a;
    return a;
}

/** One row per pair+round+tournament. Finished/Live win over a stale fixture. */
export function dedupeBoardByPair(board) {
    const byPair = new Map();
    const leftovers = [];
    for (const m of board || []) {
        const pk = rowPairKey(m);
        if (!pk) {
            leftovers.push(m);
            continue;
        }
        const prev = byPair.get(pk);
        byPair.set(pk, prev ? preferBoardRow(prev, m) : m);
    }
    return [...leftovers, ...byPair.values()];
}

/** True when a fixture start is in the past. Date-only is Delayed only after that UTC day. */
export function isPastScheduledStart(date, now = new Date()) {
    if (!date) return false;
    const s = String(date).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return s < now.toISOString().slice(0, 10);
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) return false;
    return t < now.getTime();
}

/** Past-start unplayed fixtures → Delayed. Never invents scores. */
export function markPastStartUnplayed(board, now = new Date()) {
    return (board || []).map(m => {
        if (!m || m.isLive || m.status === 'Live' || m.status === 'Finished') return m;
        if ((m.setScores || []).length) return m;
        if (!isPastScheduledStart(m.date, now)) return m;
        return { ...m, status: 'Delayed', isLive: false };
    });
}

export function snapshotSeenLive(rows) {
    return (rows || [])
        .filter(m => m && (m.isLive || m.status === 'Live' || m.stickyComplete))
        .map(m => ({
            matchKey:       String(m.matchKey || ''),
            player1Key:     String(m.player1Key || ''),
            player2Key:     String(m.player2Key || ''),
            player1Name:    m.player1Name || '',
            player2Name:    m.player2Name || '',
            roundId:        m.roundId,
            tournamentKey:  String(m.tournamentKey || ''),
            setScores:      Array.isArray(m.setScores) ? m.setScores : [],
            currentGame:    m.currentGame ?? null,
            stickyComplete: !!m.stickyComplete,
            ...(m.eventType ? { eventType: m.eventType } : {}),
        }));
}

export function mergeSeenSnapshots(seen, done) {
    const map = new Map();
    const add = (row) => {
        if (!row) return;
        const k = rowPairKey(row) || String(row.matchKey || '');
        if (!k) return;
        const prev = map.get(k);
        if (!prev) {
            map.set(k, row);
            return;
        }
        const prevN = (prev.setScores || []).length;
        const nextN = (row.setScores || []).length;
        map.set(k, nextN >= prevN ? row : prev);
    };
    for (const row of done || []) add(row);
    for (const row of seen || []) add(row);
    return [...map.values()];
}

export function completedSetChanged(prevDone, nextDone) {
    const keys = (rows) => new Set(
        (rows || []).map(r => rowPairKey(r) || String(r.matchKey || '')).filter(Boolean),
    );
    const a = keys(prevDone);
    const b = keys(nextDone);
    if (a.size !== b.size) return true;
    for (const k of a) if (!b.has(k)) return true;
    return false;
}

function liveIdentityKeys(liveRows) {
    const keys = new Set();
    for (const l of liveRows || []) {
        if (l?.matchKey) keys.add(`k:${l.matchKey}`);
        const pk = rowPairKey(l);
        if (pk) keys.add(`p:${pk}`);
    }
    return keys;
}

/**
 * InPlay that vanished from Extend live stays Finished with last known scores
 * until Core results confirm. Does not invent scores.
 */
export function applyStickyCompletions(board, previousSeen, liveRows) {
    const liveNow = liveIdentityKeys(liveRows);
    const result = (board || []).map(m => ({ ...m }));
    const byKey  = new Map();
    const byPair = new Map();
    for (const m of result) {
        if (m.matchKey) byKey.set(String(m.matchKey), m);
        const pk = rowPairKey(m);
        if (pk) byPair.set(pk, m);
    }

    for (const seen of previousSeen || []) {
        const pk = rowPairKey(seen);
        const stillLive = (seen.matchKey && liveNow.has(`k:${seen.matchKey}`))
            || (pk && liveNow.has(`p:${pk}`));
        if (stillLive) continue;

        const lastScores = Array.isArray(seen.setScores) ? seen.setScores : [];
        const hit = (seen.matchKey && byKey.get(String(seen.matchKey)))
            || (pk && byPair.get(pk));

        if (hit) {
            if (hit.isLive || hit.status === 'Finished') continue;
            hit.isLive = false;
            hit.status = 'Finished';
            hit.stickyComplete = true;
            if (lastScores.length && !(hit.setScores || []).length) {
                hit.setScores = lastScores;
            }
            if (seen.currentGame != null && hit.currentGame == null) {
                hit.currentGame = seen.currentGame;
            }
        } else if (lastScores.length || seen.stickyComplete) {
            const added = {
                matchKey:      seen.matchKey,
                player1Key:    seen.player1Key,
                player2Key:    seen.player2Key,
                player1Name:   seen.player1Name || '',
                player2Name:   seen.player2Name || '',
                isLive:        false,
                status:        'Finished',
                setScores:     lastScores,
                currentGame:   seen.currentGame ?? null,
                roundId:       seen.roundId,
                tournamentKey: seen.tournamentKey,
                stickyComplete: true,
                ...(seen.eventType ? { eventType: seen.eventType } : {}),
            };
            result.push(added);
            if (added.matchKey) byKey.set(String(added.matchKey), added);
            if (pk) byPair.set(pk, added);
        }
    }
    return result;
}

export function stripStickyFlag(row) {
    if (!row || !('stickyComplete' in row)) return row;
    const { stickyComplete: _drop, ...rest } = row;
    return rest;
}

/** Overlay InPlay / Finished / Delayed onto hub featured + today's board. No extras. */
export function applyLiveOverlayToHub(hubData, liveRows) {
    if (!hubData) return hubData;
    const overlay = (liveRows || []).filter(isActiveOverlay);
    if (!overlay.length) return hubData;

    const originalToday = hubData.todaysMatches || [];
    const origKeys = new Set(originalToday.map(m => String(m.matchKey)));
    const todaysMatches = mergeLiveOverBoard(originalToday, overlay)
        .filter(m => origKeys.has(String(m.matchKey)));

    let featuredMatch = hubData.featuredMatch || null;
    if (featuredMatch) {
        featuredMatch = mergeLiveOverBoard([featuredMatch], overlay)[0];
    }
    const liveFeatured = todaysMatches.find(m => m.isLive);
    if (liveFeatured && !featuredMatch?.isLive) {
        featuredMatch = liveFeatured;
    }
    return { ...hubData, todaysMatches, featuredMatch };
}
