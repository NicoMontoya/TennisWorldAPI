// RapidAPI fixtures (today / date / tournament) are not api-tennis rows.
// Livescore and hub unwrap `response.data` and read `id`, `player1.name`,
// `roundId`. The old transformFixtures mapper reads `event_key` /
// `event_date` / `tournament_name` and turns every RapidAPI row into blanks.
// This normalizer unwraps the same way, maps the RapidAPI fields, and drops
// any row that still has no matchKey.

import { ROUND_NAME } from './matchstatLive.js';
import { transformFixtures } from './index.js';
import { fixtureTier } from './fixtureTier.js';

export function unwrapFixtureList(raw) {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.result)) return raw.result;
    return [];
}

function splitDateTime(value) {
    if (value == null || value === '') return { date: '', time: '', startsAtUtc: '' };
    const text = String(value).trim();
    const iso = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    const date = iso ? iso[1] : (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '');
    const time = iso ? iso[2] : '';
    return { date, time, startsAtUtc: toUtcTimestamp(text) };
}

// Full upstream instant, ISO 8601 with Z. A date-only value has no clock, so
// startsAtUtc stays empty rather than inventing midnight.
function toUtcTimestamp(text) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '';
    const zoned = /Z$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`;
    const ms = Date.parse(zoned);
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toISOString();
}

function roundLabel(row) {
    if (row?.roundId != null && ROUND_NAME[row.roundId]) return ROUND_NAME[row.roundId];
    if (row?.round?.name) return String(row.round.name);
    if (row?.roundId != null && row.roundId !== '') return `Round ${row.roundId}`;
    return '';
}

function isRapidFixture(row) {
    if (!row || typeof row !== 'object') return false;
    if (row.event_key != null && row.event_key !== '') return false;
    return row.id != null || row.matchId != null || row.player1 != null || row.player1Id != null;
}

function mapRapidFixture(row, fallback) {
    const id = row?.id ?? row?.matchId;
    const matchKey = id == null || id === '' ? '' : String(id);
    const when = splitDateTime(row?.date || row?.startTime || row?.timeGame);
    const tournamentKey = String(
        row?.tournament?.id ?? row?.tournamentId ?? fallback.tournamentKey ?? '',
    );
    const tournamentName = String(
        row?.tournament?.name ?? fallback.tournamentName ?? '',
    ).trim();
    const tour = fallback.tour || '';
    const tier = fixtureTier({
        tournamentName,
        rankName: row?.tournament?.rank?.name || row?.tournament?.tier || '',
        rankId: row?.tournament?.rankId ?? row?.tournament?.rank?.id,
        // Upstream level only. `${tour} Singles` is a category we add below,
        // not evidence that the event is tour-level.
        eventType: row?.tourType || row?.event_type_type || '',
    });
    return {
        matchKey,
        tournamentKey,
        tournamentName,
        date: when.date,
        time: when.time,
        startsAtUtc: when.startsAtUtc,
        status: 'Not Started',
        round: roundLabel(row),
        season: when.date ? when.date.slice(0, 4) : '',
        eventType: tour ? `${tour} Singles` : '',
        tier,
        player1Key: String(row?.player1Id ?? row?.player1?.id ?? ''),
        player1Name: row?.player1?.name || '',
        player1Logo: '',
        player2Key: String(row?.player2Id ?? row?.player2?.id ?? ''),
        player2Name: row?.player2?.name || '',
        player2Logo: '',
        finalResult: '',
        winner: '',
        isLive: false,
        setScores: [],
        currentGame: null,
        roundId: row?.roundId ?? null,
    };
}

/** @returns {object[]} rows that have a matchKey */
export function normalizeFixturesFeed(raw, fallback = {}) {
    const out = [];
    for (const row of unwrapFixtureList(raw)) {
        let mapped;
        if (isRapidFixture(row)) mapped = mapRapidFixture(row, fallback);
        else {
            mapped = transformFixtures([row])[0];
            if (mapped) {
                mapped.tier = fixtureTier({
                    tournamentName: mapped.tournamentName,
                    eventType: mapped.eventType,
                });
            }
        }
        if (mapped?.matchKey) out.push(mapped);
    }
    return out;
}

// ±14 days. A livescore startTimestamp outside this window cannot become
// startsAtUtc — that instant is what Sprint 2c will use to lock a pick.
export const START_TIMESTAMP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const STATUS_RANK = {
    'Not Started': 0,
    Delayed: 1,
    Live: 2,
    Finished: 3,
    Walkover: 3,
    Cancelled: 3,
};

// Highest precedence wins when one upstream string contains several words
// ('Finished (retired)' is retired, not finished).
const FEED_CATEGORY_RANK = {
    cancelled: 7,
    walkover: 6,
    retired: 5,
    finished: 4,
    delayed: 3,
    live: 2,
    notstarted: 1,
};

const PRIVATE_ROW_FIELDS = new Set([
    'session', 'sessionid', 'sessiontoken',
    'member', 'memberid', 'memberemail',
    'user', 'userid', 'email',
    'token', 'accesstoken', 'refreshtoken',
    'authorization', 'cookie', 'password', 'setcookie', 'auth',
]);

// In-memory only. A cached overlay can carry a startsAtUtc we already
// accepted; a JSON cache row cannot set this symbol.
const TRUSTED_START = Symbol('tw.fixtureTrustedStart');

function foldLabel(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Split on punctuation so 'Ret.', 'W/O', and 'Retired - player1' yield words.
// `w/o` is rewritten first so the slash does not leave two stray letters.
function statusWords(value) {
    if (value == null || value === '') return [];
    const text = String(value).toLowerCase().replace(/w\s*\/\s*o/g, ' walkover ');
    return text.split(/[^a-z0-9]+/).filter(Boolean);
}

function wordsInclude(words, list) {
    return words.some(word => list.includes(word));
}

function hasPhrase(words, first, second) {
    return words.some((word, index) => word === first && words[index + 1] === second);
}

function categoryOfWords(words) {
    if (!words.length) return '';
    let best = '';
    let rank = 0;
    const consider = (name, matched) => {
        if (matched && FEED_CATEGORY_RANK[name] > rank) {
            best = name;
            rank = FEED_CATEGORY_RANK[name];
        }
    };
    consider('cancelled', wordsInclude(words, ['cancelled', 'canceled', 'abandoned']));
    consider('walkover', wordsInclude(words, ['walkover', 'wo']) || hasPhrase(words, 'walk', 'over'));
    consider('retired', wordsInclude(words, ['retired', 'retirement', 'ret']));
    consider('finished', wordsInclude(words, ['finished', 'ended', 'complete', 'completed', 'final']));
    consider('delayed', wordsInclude(words, ['delayed', 'postponed', 'suspended', 'interrupted']));
    consider('live', wordsInclude(words, ['live', 'inplay', 'inprogress'])
        || hasPhrase(words, 'in', 'play')
        || hasPhrase(words, 'in', 'progress'));
    consider('notstarted', wordsInclude(words, ['notstarted', 'upcoming', 'scheduled'])
        || hasPhrase(words, 'not', 'started'));
    return best;
}

function bestFeedCategory(overlay, { skipStatus = false } = {}) {
    if (!overlay || typeof overlay !== 'object') return '';
    const fields = [
        overlay.statusText,
        overlay.rawStatus,
        overlay.eventStatus,
        overlay.event_status,
    ];
    if (!skipStatus) fields.push(overlay.status);
    let best = '';
    let rank = 0;
    for (const value of fields) {
        const category = categoryOfWords(statusWords(value));
        if (category && FEED_CATEGORY_RANK[category] > rank) {
            best = category;
            rank = FEED_CATEGORY_RANK[category];
        }
    }
    return best;
}

function sideKey(row, side) {
    if (!row || typeof row !== 'object') return '';
    const value = side === 1
        ? (row.player1Key ?? row.player1Id)
        : (row.player2Key ?? row.player2Id);
    if (value == null || value === '') return '';
    return String(value);
}

/** `p1-p2-tournament-round`, the composite livescore already resolves. */
export function fixtureCompositeKey(row, swap = false) {
    const p1 = sideKey(row, swap ? 2 : 1);
    const p2 = sideKey(row, swap ? 1 : 2);
    const tournament = row?.tournamentKey ?? row?.tournamentId;
    const round = row?.roundId;
    if (!p1 || !p2 || tournament == null || tournament === '') return '';
    if (round == null || round === '') return '';
    return `${p1}-${p2}-${tournament}-${round}`;
}

function isFixtureInstant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return false;
    return Number.isFinite(Date.parse(value));
}

function instantMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    // Unix seconds are ~1e9. Milliseconds are ~1e12. Don't scale a value
    // that is already an absolute instant.
    return Math.abs(value) >= 1e12 ? value : value * 1000;
}

/**
 * Unix startTimestamp → ISO, or ''.
 * Only a finite number whose instant sits within ±14 days of `now`.
 * Numeric strings, booleans, and anything else are rejected.
 */
export function startsAtUtcFromTimestamp(value, now = new Date()) {
    const ms = instantMs(value);
    if (ms == null) return '';
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(nowMs)) return '';
    if (Math.abs(ms - nowMs) > START_TIMESTAMP_WINDOW_MS) return '';
    return new Date(ms).toISOString();
}

export function withTrustedStart(row, iso) {
    if (!row || typeof row !== 'object' || !isFixtureInstant(iso)) return row;
    Object.defineProperty(row, TRUSTED_START, { value: iso, enumerable: false });
    return row;
}

function preferStart(current, overlay, now) {
    if (isFixtureInstant(current)) return current;
    const fromTimestamp = startsAtUtcFromTimestamp(overlay?.startTimestamp, now);
    if (fromTimestamp) return fromTimestamp;
    const trusted = overlay?.[TRUSTED_START];
    if (isFixtureInstant(trusted)) return trusted;
    return typeof current === 'string' ? current : '';
}

function scoreListOf(scores) {
    if (!Array.isArray(scores)) return [];
    const out = [];
    for (const item of scores) {
        if (typeof item === 'string' && item.trim()) out.push(item.trim());
        else if (typeof item === 'number' && Number.isFinite(item)) out.push(String(item));
    }
    return out;
}

function recordedWinnerKey(fixture, overlay) {
    const p1 = sideKey(overlay, 1) || sideKey(fixture, 1);
    const p2 = sideKey(overlay, 2) || sideKey(fixture, 2);
    const raws = [overlay?.winner, overlay?.winnerKey, overlay?.match_winner, overlay?.matchWinner];
    for (const raw of raws) {
        if (raw == null || raw === '') continue;
        const text = String(raw).trim();
        const folded = foldLabel(text);
        if (folded === 'player1' || folded === 'firstplayer' || folded === 'first') return p1;
        if (folded === 'player2' || folded === 'secondplayer' || folded === 'second') return p2;
        if (p1 && text === p1) return p1;
        if (p2 && text === p2) return p2;
    }
    return '';
}

function knownWinner(row) {
    const winner = row?.winner == null ? '' : String(row.winner);
    if (!winner) return '';
    const p1 = sideKey(row, 1);
    const p2 = sideKey(row, 2);
    return winner === p1 || winner === p2 ? winner : '';
}

function knownStatus(status) {
    return Object.prototype.hasOwnProperty.call(STATUS_RANK, status) ? status : 'Not Started';
}

function holdingStatus(baseStatus) {
    return baseStatus === 'Delayed' ? 'Delayed' : 'Live';
}

// Not part of the JSON payload. Distinguishes a feed that said walkover
// (sticky) from a walkover inferred because a winner had no set scores.
const WALKOVER_KIND = Symbol('tw.walkoverKind');

export function walkoverKindOf(row) {
    const kind = row?.[WALKOVER_KIND];
    return kind === 'text' || kind === 'inferred' ? kind : '';
}

export function tagWalkoverKind(row, kind) {
    if (!row || typeof row !== 'object') return row;
    if (kind === 'text' || kind === 'inferred') {
        Object.defineProperty(row, WALKOVER_KIND, { value: kind, enumerable: false });
    }
    return row;
}

// Upstream text first, by precedence: cancelled/abandoned > walkover >
// retired > finished > delayed/suspended/interrupted > live > not started.
// Finished is never emitted from the word alone. A winner with no sets is
// an inferred Walkover unless the feed text itself said walkover or retired.
function classifyOverlay(baseStatus, fixture, overlay) {
    const scores = scoreListOf(overlay?.setScores);
    const winner = recordedWinnerKey(fixture, overlay) || knownWinner(fixture) || knownWinner(overlay);
    const replay = walkoverKindOf(overlay);
    if (replay === 'text') {
        return {
            status: 'Walkover',
            winner,
            scores: [],
            feedWalkover: true,
            currentGame: null,
        };
    }
    const category = bestFeedCategory(overlay, { skipStatus: replay === 'inferred' });
    const feedWalkover = category === 'walkover';
    let status = 'Not Started';

    if (category === 'cancelled') status = 'Cancelled';
    else if (category === 'walkover') status = 'Walkover';
    else if (category === 'retired') status = winner ? 'Finished' : holdingStatus(baseStatus);
    else if (category === 'delayed') status = 'Delayed';
    else if (category === 'live') status = 'Live';
    else if (category === 'finished') {
        if (!winner) status = holdingStatus(baseStatus);
        else if (!scores.length) status = 'Walkover';
        else status = 'Finished';
    } else if (category === 'notstarted') status = 'Not Started';
    else if (overlay?.isLive === true) status = 'Live';
    else if (winner && !scores.length) status = 'Walkover';
    else if (winner && scores.length) status = 'Finished';

    return {
        status,
        winner,
        scores,
        feedWalkover,
        currentGame: overlay?.currentGame,
    };
}

function normalizeGame(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text || null;
}

function projectStatus(row, status, classified) {
    const next = {
        ...row,
        status,
        isLive: status === 'Live',
    };
    if (status === 'Live' || status === 'Finished') {
        next.setScores = classified.scores.length
            ? classified.scores
            : (Array.isArray(row.setScores) ? row.setScores.slice() : []);
        const game = normalizeGame(classified.currentGame);
        next.currentGame = status === 'Live'
            ? (game == null ? (row.currentGame ?? null) : game)
            : null;
    } else {
        next.setScores = [];
        next.currentGame = null;
    }
    if (classified.winner) next.winner = classified.winner;
    else if (status === 'Finished' || status === 'Walkover' || status === 'Cancelled') {
        next.winner = knownWinner(row);
    } else next.winner = '';
    return next;
}

function kindFor(status, feedWalkover) {
    if (status !== 'Walkover') return '';
    return feedWalkover ? 'text' : 'inferred';
}

function mergeOne(row, overlay, now) {
    const baseStatus = knownStatus(row?.status);
    const baseKind = walkoverKindOf(row);
    const classified = classifyOverlay(baseStatus, row, overlay);
    const startsAtUtc = preferStart(row?.startsAtUtc, overlay, now);
    const keep = () => tagWalkoverKind({ ...row, startsAtUtc }, baseKind);

    // Cancelled sticks. A new cancelled feed also wins over a walkover.
    if (baseStatus === 'Cancelled') return keep();
    if (classified.status === 'Cancelled') {
        const next = projectStatus(row, 'Cancelled', classified);
        next.startsAtUtc = startsAtUtc;
        return next;
    }

    // Only a walkover the feed actually named is sticky. Scores must not
    // turn it into Finished, in either merge order.
    if (baseKind === 'text') return keep();
    if (classified.feedWalkover) {
        const next = projectStatus(row, 'Walkover', classified);
        next.startsAtUtc = startsAtUtc;
        return tagWalkoverKind(next, 'text');
    }

    // A scored Finished stays Finished. An inferred walkover must not erase it.
    if (baseStatus === 'Finished' && classified.status !== 'Finished') return keep();

    // Winner + no sets was only a guess. Set scores from either cache promote it.
    if (baseKind === 'inferred' && classified.status === 'Finished' && classified.scores.length) {
        const next = projectStatus(row, 'Finished', classified);
        next.startsAtUtc = startsAtUtc;
        return next;
    }
    if (baseStatus === 'Walkover' && baseKind === 'inferred') return keep();

    const baseRank = STATUS_RANK[baseStatus] ?? 0;
    const nextRank = STATUS_RANK[classified.status] ?? 0;
    // Live and Delayed do not fall back to Not Started.
    if (nextRank < baseRank) return keep();

    const projected = projectStatus(row, classified.status, classified);
    projected.startsAtUtc = startsAtUtc;
    return tagWalkoverKind(projected, kindFor(projected.status, classified.feedWalkover));
}

function isPrivateField(key) {
    const folded = String(key).toLowerCase().replace(/[_-]/g, '');
    if (PRIVATE_ROW_FIELDS.has(folded)) return true;
    return folded.includes('session') || folded.includes('member');
}

function stripPrivate(row) {
    const out = { ...row };
    for (const key of Object.keys(out)) {
        if (isPrivateField(key)) delete out[key];
    }
    return out;
}

function indexOverlays(rows) {
    const byKey = new Map();
    const add = (key, row) => {
        if (!key) return;
        const list = byKey.get(key);
        if (list) {
            if (!list.includes(row)) list.push(row);
        } else byKey.set(key, [row]);
    };
    for (const row of rows || []) {
        if (!row || typeof row !== 'object') continue;
        const matchKey = row.matchKey == null || row.matchKey === '' ? '' : String(row.matchKey);
        add(matchKey, row);
        add(fixtureCompositeKey(row), row);
        add(fixtureCompositeKey(row, true), row);
    }
    return byKey;
}

function overlaysFor(row, byKey) {
    const found = [];
    const keys = [
        row?.matchKey == null || row.matchKey === '' ? '' : String(row.matchKey),
        fixtureCompositeKey(row),
        fixtureCompositeKey(row, true),
    ];
    for (const key of keys) {
        const list = key ? byKey.get(key) : null;
        if (!list) continue;
        for (const overlay of list) {
            if (!found.includes(overlay)) found.push(overlay);
        }
    }
    found.sort((a, b) => {
        const ra = STATUS_RANK[classifyOverlay('Not Started', a, a).status] ?? 0;
        const rb = STATUS_RANK[classifyOverlay('Not Started', b, b).status] ?? 0;
        return ra - rb;
    });
    return found;
}

/**
 * Merge already-cached livescore/results rows onto fixture rows.
 * Does not fetch. A miss is the fixture row plus statusAsOf.
 * @param {object[]} rows
 * @param {object[]} overlayRows
 * @param {{ now?: Date, statusAsOf?: string }} [options]
 */
export function applyFixtureOverlay(rows, overlayRows, { now = new Date(), statusAsOf = '' } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const byKey = indexOverlays(overlayRows);
    const asOf = typeof statusAsOf === 'string' ? statusAsOf : '';
    return list.map(row => {
        if (!row || typeof row !== 'object') return row;
        let next = tagWalkoverKind({ ...row }, walkoverKindOf(row));
        for (const overlay of overlaysFor(row, byKey)) {
            next = mergeOne(next, overlay, now);
        }
        const kind = walkoverKindOf(next);
        next.statusAsOf = asOf;
        return tagWalkoverKind(stripPrivate(next), kind);
    });
}
