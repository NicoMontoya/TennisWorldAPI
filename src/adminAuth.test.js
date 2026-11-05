import { describe, expect, it } from 'vitest';
import worker from './index.js';
import { adminSecretsMatch, requireAdmin } from './adminAuth.js';

describe('admin secret compare', () => {
    it('matches in constant time, including when the lengths differ', () => {
        expect(adminSecretsMatch('test-admin-secret', 'test-admin-secret')).toBe(true);
        expect(adminSecretsMatch('test-admin-secret', 'test-admin-secreT')).toBe(false);
        expect(adminSecretsMatch('short', 'test-admin-secret')).toBe(false);
        expect(adminSecretsMatch('test-admin-secret-extra', 'test-admin-secret')).toBe(false);
        expect(adminSecretsMatch('', 'test-admin-secret')).toBe(false);
        expect(adminSecretsMatch('test-admin-secret', '')).toBe(false);
    });

    it('rejects a wrong or missing x-admin-secret without using a prefix check', async () => {
        const env = { ADMIN_SECRET: 'test-admin-secret', CORS_ORIGIN: '*' };
        expect(() => requireAdmin(new Request('https://example.test/api/admin/backfill-last-good', {
            method: 'POST',
            headers: { 'x-admin-secret': 'test-admin-secret-extra' },
        }), env)).toThrow(/Unauthorized/);

        const res = await worker.fetch(new Request('https://example.test/api/admin/backfill-last-good', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-secret': 'test',
            },
            body: JSON.stringify({ resource: 'fixtures', tour: 'ATP' }),
        }), env);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' });
    });
});
