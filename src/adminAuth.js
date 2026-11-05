// Shared gate for import/backfill routes.
// POST only. Header x-admin-secret only (query secrets are ignored).
// Fail closed when ADMIN_SECRET is unset or does not match.
// The compare is constant-time: HMAC both sides so length cannot leak, then
// timingSafeEqual. A thrown compare is a denial, not a 500.

import { createHmac, timingSafeEqual } from 'node:crypto';

const COMPARE_KEY = Buffer.from('tw-admin-header-v1');

export function adminSecretsMatch(provided, expected) {
    if (typeof expected !== 'string' || expected.length === 0) return false;
    const left = typeof provided === 'string' ? provided : '';
    try {
        const a = createHmac('sha256', COMPARE_KEY).update(left, 'utf8').digest();
        const b = createHmac('sha256', COMPARE_KEY).update(expected, 'utf8').digest();
        return timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

export function requireAdmin(request, env) {
    if (!request || request.method !== 'POST') {
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    }
    const header = request.headers.get('x-admin-secret') || '';
    if (!env?.ADMIN_SECRET || !adminSecretsMatch(header, env.ADMIN_SECRET)) {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }
}
