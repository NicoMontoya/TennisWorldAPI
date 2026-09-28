// Non-enumerable stamp so /api/livescore can carry the upstream fetch time
// to the HTTP layer. index.js copies it to the X-Fetched-At response header.
// JSON.stringify leaves the symbol off the match array.

const FETCHED_AT = Symbol.for('tw.fetchedAt');

export function stampFetchedAt(data, fetchedAt) {
    if (!data || typeof fetchedAt !== 'string' || !fetchedAt) return data;
    Object.defineProperty(data, FETCHED_AT, { value: fetchedAt, enumerable: false });
    return data;
}

export function takeFetchedAt(data) {
    if (!data || typeof data !== 'object') return undefined;
    const value = data[FETCHED_AT];
    return typeof value === 'string' && value ? value : undefined;
}
