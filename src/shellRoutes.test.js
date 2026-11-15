import { afterEach, describe, expect, it } from 'vitest';
import worker from './index.js';

const HTML = '<!doctype html><html data-tw-preview="sprint1"><title>TennisWorld — Preview</title></html>';

function assetsEnv(headers) {
    const fetched = [];
    return {
        env: {
            CORS_ORIGIN: '*',
            ASSETS: {
                async fetch(request) {
                    fetched.push(request.url);
                    return new Response(HTML, {
                        status: 200,
                        headers,
                    });
                },
            },
        },
        fetched,
    };
}

describe('sprint1 shell routes', () => {
    afterEach(() => {
        delete globalThis.caches;
    });

    it('serves sprint1.html for the four shell paths, including a trailing slash and query', async () => {
        const { env, fetched } = assetsEnv({
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
        });
        const paths = [
            '/today',
            '/schedule',
            '/picks',
            '/me',
            '/today/',
            '/schedule/?week=1',
            '/picks?tour=WTA',
            '/me/?x=1',
        ];
        for (const path of paths) {
            const res = await worker.fetch(new Request(`https://example.test${path}`), env);
            const body = await res.text();
            expect(res.status, path).toBe(200);
            expect(res.headers.get('content-type'), path).toMatch(/text\/html/i);
            expect(body, path).toBe(HTML);
            expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
            expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
            expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
        }
        expect(fetched.length).toBe(paths.length);
        expect(fetched.every(url => url.endsWith('/sprint1.html'))).toBe(true);
    });

    it('follows a 307 from /sprint1.html on the server and keeps the shell URL', async () => {
        const fetched = [];
        const env = {
            CORS_ORIGIN: '*',
            ASSETS: {
                async fetch(request) {
                    const url = new URL(request.url);
                    fetched.push(url.pathname);
                    if (url.pathname === '/sprint1.html') {
                        return new Response(null, {
                            status: 307,
                            headers: { Location: '/sprint1' },
                        });
                    }
                    if (url.pathname === '/sprint1') {
                        return new Response(HTML, {
                            status: 200,
                            headers: {
                                'Content-Type': 'text/html; charset=utf-8',
                                'X-Content-Type-Options': 'nosniff',
                            },
                        });
                    }
                    return new Response('missing', { status: 404 });
                },
            },
        };
        const res = await worker.fetch(new Request('https://example.test/today?tour=ATP'), env);
        expect(res.status).toBe(200);
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get('content-type')).toMatch(/text\/html/i);
        expect(res.headers.get('x-robots-tag')).toBe('noindex');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await res.text()).toBe(HTML);
        expect(fetched).toEqual(['/sprint1.html', '/sprint1']);
    });

    it('keeps an X-Robots-Tag the asset response already set', async () => {
        const { env } = assetsEnv({
            'Content-Type': 'text/html; charset=utf-8',
            'X-Robots-Tag': 'noindex, nofollow',
        });
        const res = await worker.fetch(new Request('https://example.test/today'), env);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    });

    it('leaves /rankings and unknown paths on the existing JSON 404', async () => {
        const { env, fetched } = assetsEnv({ 'Content-Type': 'text/html' });
        const paths = ['/rankings', '/todayx', '/api/today', '/foo', '/today//', '/today/extra'];
        for (const path of paths) {
            const res = await worker.fetch(new Request(`https://example.test${path}`), env);
            expect(res.status, path).toBe(404);
            expect(await res.json(), path).toEqual({ error: `Unknown route: ${path}` });
        }
        const post = await worker.fetch(new Request('https://example.test/today', { method: 'POST' }), env);
        expect(post.status).toBe(404);
        expect(await post.json()).toEqual({ error: 'Unknown route: /today' });
        expect(fetched).toEqual([]);
    });
});
