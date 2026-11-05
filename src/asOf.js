// Last-good responses keep the same payload the route already returned
// (array or object). asOf rides a WeakMap so it is not a JSON field on that
// payload and does not change deep-equality of success bodies. index.js
// copies it to the top-level `{ ok, data, asOf }` envelope.

const asOfByPayload = new WeakMap();

export function tagAsOf(payload, asOf) {
    if (!asOf || payload === null || typeof payload !== 'object') return payload;
    asOfByPayload.set(payload, String(asOf));
    return payload;
}

export function readAsOf(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = asOfByPayload.get(payload);
    return typeof value === 'string' && value ? value : undefined;
}
