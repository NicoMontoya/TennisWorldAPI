// Shared gate for import/backfill routes.
// POST only. Header x-admin-secret only (query secrets are ignored).
// Fail closed when ADMIN_SECRET is unset or does not match.

export function requireAdmin(request, env) {
    if (!request || request.method !== 'POST') {
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    }
    const header = request.headers.get('x-admin-secret') || '';
    if (!env?.ADMIN_SECRET || header !== env.ADMIN_SECRET) {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }
}
