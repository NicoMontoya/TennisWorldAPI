// Fixture level for /api/fixtures ordering.
//
// `tier` is one of 'tour' | 'challenger' | 'itf'. The UI can group on it.
// Signals are the tournament name, the calendar/rank label, rankId, and an
// upstream event-type string. Rank id wins when it is one of the ids below.
// Names are the fallback.
//
// rankId (GET /ranking, also tournament.rankId on the fixtures feed):
//   0 ITF / Futures ($10K)
//   1 Challenger, or ITF above $10K
//   2 Main tour — ATP/WTA 250 and 500 share this id
//   3 Masters / 1000
//   4 Grand Slam
//   5 Davis Cup, Fed Cup, Billie Jean King Cup
//   7 Tour Finals
//
// Names, checked only when rankId is missing or not one of those ids.
// Challenger and ITF are tested before tour so "ATP Challenger" is not tour.
//   itf        — ITF, Futures, M15/M25/W15/W35/W100 and similar level codes
//   challenger — Challenger, WTA 125
//   tour       — Grand Slam, Australian Open, Roland Garros, French Open,
//                Wimbledon, US Open, Masters, 1000, 500, 250, Finals,
//                United Cup, Davis, Billie Jean King, BJK, Fed Cup, "Main tour"
//
// "ATP Singles" / "WTA Singles" / "ATP Doubles" / "WTA Doubles" / "Mixed Doubles"
// are category labels, not a level. They do not count as tour.
// A name with none of these signals is 'itf' so it sorts after tour and
// challenger and cannot crowd them out.

const TOUR_RANK_IDS = new Set([2, 3, 4, 5, 7]);

const GENERIC_EVENT = /^(?:atp|wta)\s+(?:singles|doubles)$|^mixed doubles$/i;
const ITF_NAME = /\bitf\b|\bfutures?\b|\b[mw]\d{2,3}\b/i;
const CHALLENGER_NAME = /\bchallenger\b|\b125\b/i;
const TOUR_NAME = /\bgrand slam\b|\baustralian open\b|\broland garros\b|\bfrench open\b|\bwimbledon\b|\bu\.?s\.?\s+open\b|\bmasters\b|\b1000\b|\b500\b|\b250\b|\bfinals\b|\bunited cup\b|\bdavis\b|\bbillie jean\b|\bbjk\b|\bfed cup\b|\bmain tour\b/i;

const TIER_SORT = { tour: 0, challenger: 1, itf: 2 };
const DAY_MS = 86_400_000;
// Slams run two weeks. A 250/500/Masters that started more than ~8 days ago
// is over even when a coarse calendar status still says "live".
const SLAM_LOOKBACK_DAYS = 14;
const TOUR_LOOKBACK_DAYS = 8;
const UPCOMING_DAYS = 21;

function levelText({ tournamentName, rankName, eventType }) {
    const event = String(eventType || '').trim();
    const usefulEvent = GENERIC_EVENT.test(event) ? '' : event;
    return [tournamentName, rankName, usefulEvent]
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join(' ');
}

export function fixtureTier({ tournamentName, rankName, rankId, eventType } = {}) {
    const id = Number(rankId);
    if (id === 0) return 'itf';
    if (id === 1) return 'challenger';
    if (TOUR_RANK_IDS.has(id)) return 'tour';

    const text = levelText({ tournamentName, rankName, eventType });
    if (!text) return 'itf';
    if (ITF_NAME.test(text)) return 'itf';
    if (CHALLENGER_NAME.test(text)) return 'challenger';
    if (TOUR_NAME.test(text)) return 'tour';
    return 'itf';
}

export function dedupeFixtures(rows) {
    const seen = new Set();
    const out = [];
    for (const row of rows || []) {
        const key = row?.matchKey == null || row.matchKey === '' ? '' : String(row.matchKey);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}

// Stable: same-tier rows keep the order they were fetched (tour event first,
// then the general feed).
export function orderFixturesByTier(rows) {
    const stamped = (rows || []).map(row => {
        if (!row || typeof row !== 'object') return row;
        if (row.tier === 'tour' || row.tier === 'challenger' || row.tier === 'itf') return row;
        return {
            ...row,
            tier: fixtureTier({
                tournamentName: row.tournamentName,
                eventType: row.eventType,
            }),
        };
    });
    return stamped.sort((a, b) => (TIER_SORT[a?.tier] ?? 9) - (TIER_SORT[b?.tier] ?? 9));
}

function eventStartMs(item) {
    const raw = item?.date || item?.startDate || '';
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : NaN;
}

function isFinishedEvent(item) {
    const finished = item?.finished;
    if (finished === true || finished === 1 || finished === '1') return true;
    const status = String(item?.status || '').trim().toLowerCase();
    return status === 'finished' || status === 'completed' || status === 'complete';
}

function isSlamEvent(name, rankName, rankId) {
    if (Number(rankId) === 4) return true;
    return /\bgrand slam\b|\bwimbledon\b|\broland garros\b|\baustralian open\b|\bfrench open\b|\bu\.?s\.?\s+open\b/i.test(`${name} ${rankName}`);
}

function targetRank(item) {
    const name = `${item.name || ''} ${item.tier || ''}`;
    const team = /\bunited cup\b|\bdavis\b|\bbillie jean\b|\bbjk\b/i.test(name);
    // "Davis Cup Finals" is a team event. Tour Finals (Nitto ATP Finals,
    // WTA Finals) take the one tournament-specific call.
    if (/\bfinals\b/i.test(item.name || '') && !team) return 0;
    if (/\bgrand slam\b|\bwimbledon\b|\broland garros\b|\baustralian open\b|\bu\.?s\.?\s+open\b/i.test(name)) return 1;
    if (/\bmasters\b|\b1000\b/i.test(name)) return 2;
    if (/\b500\b/i.test(name)) return 3;
    if (team) return 4;
    if (/\b250\b/i.test(name)) return 5;
    return 6;
}

function overlapsQuery(startMs, query) {
    if (!query?.dateStart && !query?.dateStop) return true;
    const iso = new Date(startMs).toISOString().slice(0, 10);
    const end = new Date(startMs + 14 * DAY_MS).toISOString().slice(0, 10);
    if (query.dateStop && iso > query.dateStop) return false;
    if (query.dateStart && end < query.dateStart) return false;
    return true;
}

/**
 * One live/upcoming tour event to spend the first fixtures call on.
 * Finals beat a Slam, Masters, 500, team event, or 250 happening in the
 * same window. Finished/completed rows, non-Slams that started more than
 * 8 days ago, lower tiers, and non-numeric ids are skipped. `query` limits
 * the window when the caller asked for dates. The caller also drops a
 * calendar copy older than 48h before this runs.
 */
export function selectTourTarget(items, now = new Date(), query = {}) {
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const latest = todayUtc + (UPCOMING_DAYS + 1) * DAY_MS;
    const seen = new Set();
    const current = [];

    for (const item of items || []) {
        const rawId = item?.id ?? item?.tournamentKey;
        const id = rawId == null ? '' : String(rawId).trim();
        if (!/^\d{1,20}$/.test(id) || seen.has(id)) continue;
        if (isFinishedEvent(item)) continue;
        const name = String(item?.name || item?.tournamentName || '').trim();
        const rankName = String(item?.tier || item?.rank?.name || '').trim();
        const rankId = item?.rankId ?? item?.rank?.id;
        if (fixtureTier({ tournamentName: name, rankName, rankId }) !== 'tour') continue;
        const lookback = isSlamEvent(name, rankName, rankId) ? SLAM_LOOKBACK_DAYS : TOUR_LOOKBACK_DAYS;
        const earliest = todayUtc - lookback * DAY_MS;
        const start = eventStartMs(item);
        if (!Number.isFinite(start) || start < earliest || start >= latest) continue;
        if (!overlapsQuery(start, query)) continue;
        seen.add(id);
        current.push({ id, name, tier: rankName });
    }

    current.sort((a, b) => targetRank(a) - targetRank(b));
    return current[0] || null;
}
