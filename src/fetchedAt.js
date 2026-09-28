// Non-enumerable stamp so /api/livescore can carry the upstream fetch time
// to the HTTP layer. index.js copies it to the X-Fetched-At response header.
// JSON.stringify leaves the symbol off the match array.
//
// Every livescore response sends the header. When no upstream fetch time is
// known, the value is the epoch so the UI treats the board as stale. The
// header is therefore always present and does not reveal a quota stop.

const FETCHED_AT = Symbol.for('tw.fetchedAt');
const FETCHED_AT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const LIVESCORE_FETCHED_AT_UNKNOWN = '1970-01-01T00:00:00.000Z';

export function normalizeFetchedAt(value) {
    return typeof value === 'string' && FETCHED_AT_ISO.test(value)
        ? value
        : LIVESCORE_FETCHED_AT_UNKNOWN;
}

export function stampFetchedAt(data, fetchedAt) {
    if (!data || typeof data !== 'object') return data;
    Object.defineProperty(data, FETCHED_AT, {
        value: normalizeFetchedAt(fetchedAt),
        enumerable: false,
    });
    return data;
}

export function takeFetchedAt(data) {
    if (!data || typeof data !== 'object') return undefined;
    const value = data[FETCHED_AT];
    return typeof value === 'string' && value ? value : undefined;
}
