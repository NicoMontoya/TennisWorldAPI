// ===================================
// Scores category (eventType) allowlist
// ===================================
// Hub / livescore match objects may carry `eventType` so the Scores UI can
// filter Men's/Women's Singles|Doubles|Mixed. Only these canonical strings
// are emitted. Unknown, missing, or lower-tier labels are omitted — never
// passed through as free text, never accepted as a query filter.

export const EVENT_TYPES = Object.freeze([
    'ATP Singles',
    'ATP Doubles',
    'WTA Singles',
    'WTA Doubles',
    'Mixed Doubles',
]);

const ALLOWED = new Set(EVENT_TYPES);

const REJECT_RE = /itf|challenger|junior|exhibition|utr|\bcollege\b|\b[mw]\s?(15|25)\b/i;

function fold(raw) {
    return String(raw ?? '')
        .trim()
        .replace(/[-_/]+/g, ' ')
        .replace(/\s+/g, ' ');
}

function tourFrom(text) {
    const s = fold(text).toLowerCase();
    if (/\batp\b/.test(s)) return 'ATP';
    if (/\bwta\b/.test(s)) return 'WTA';
    return null;
}

function disciplineFrom(text) {
    const s = fold(text).toLowerCase();
    if (/\bmixed\b/.test(s)) return 'Mixed';
    if (/\bdoubles?\b/.test(s)) return 'Doubles';
    if (/\bsingles?\b/.test(s)) return 'Singles';
    return null;
}

/**
 * Map an upstream label onto the canonical allowlist.
 * ATP/WTA Mixed (and bare "Mixed") → Mixed Doubles.
 * Bare "ATP" / "WTA" is tour-only — not enough for a category.
 * Rejected / unknown strings → null (caller omits the field).
 */
export function normalizeEventType(raw) {
    if (raw == null) return null;
    const text = fold(raw);
    if (!text || REJECT_RE.test(text)) return null;

    const lowered = text.toLowerCase();
    if (ALLOWED.has(text)) return text;
    for (const allowed of EVENT_TYPES) {
        if (allowed.toLowerCase() === lowered) return allowed;
    }

    if (/\bmixed\b/.test(lowered)) return 'Mixed Doubles';

    const tour = tourFrom(text);
    const disc = disciplineFrom(text);
    if (tour && (disc === 'Singles' || disc === 'Doubles')) {
        const canonical = `${tour} ${disc}`;
        return ALLOWED.has(canonical) ? canonical : null;
    }
    return null;
}

function namesLookDoubles(player1Name, player2Name) {
    return [player1Name, player2Name].some(n => String(n || '').includes('/'));
}

/**
 * Derive an allowlisted eventType from fields already on MatchStat / Core
 * matches. Does not invent a category when tour is the only signal.
 *
 * Signals (first match wins after normalize):
 *   1. Explicit upstream label (tourType, event_type_type, eventType, …)
 *   2. Core results bucket (`singles` | `doubles`) + validated tour
 *   3. In-repo doubles heuristic (`/` in a player name) + validated tour
 *
 * `tour` must already be ATP|WTA from parseTour — never a free-text query.
 */
export function deriveEventType({
    raw,
    tour,
    bucket,
    doubles,
    player1Name,
    player2Name,
} = {}) {
    const fromRaw = normalizeEventType(raw);
    if (fromRaw) return fromRaw;
    if (raw != null && String(raw).trim() !== '' && REJECT_RE.test(String(raw))) {
        return null;
    }

    const t = tour === 'ATP' || tour === 'WTA' ? tour : tourFrom(raw);
    if (!t) return null;

    const hasNames = player1Name != null || player2Name != null;
    const looksDoubles = doubles === true
        || bucket === 'doubles'
        || (hasNames && namesLookDoubles(player1Name, player2Name));

    if (looksDoubles) return normalizeEventType(`${t} Doubles`);

    // Singles only with a positive signal — never from tour alone.
    const looksSingles = bucket === 'singles'
        || doubles === false
        || (hasNames && !namesLookDoubles(player1Name, player2Name));
    if (looksSingles) return normalizeEventType(`${t} Singles`);
    return null;
}

/** Attach eventType only when known (omit otherwise — never invent). */
export function assignEventType(row, hints) {
    if (!row) return row;
    const eventType = deriveEventType(hints);
    if (eventType) row.eventType = eventType;
    else delete row.eventType;
    return row;
}
