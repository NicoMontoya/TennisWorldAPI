// Non-enumerable stamp so a route can carry the upstream fetch time to the
// HTTP layer without adding a field on a match array or a hub object.
// index.js copies it to the response as top-level `fetchedAt` and JSON
// leaves the symbol off `data`.

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
