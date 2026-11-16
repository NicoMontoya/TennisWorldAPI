import { afterEach, describe, expect, it } from 'vitest';
import worker from './index.js';

const HTML = '<!doctype html><html data-tw-preview="sprint1"><title>TennisWorld — Preview</title></html>';
const HTML_WITH_META = '<!doctype html><html data-tw-preview="sprint1"><meta name="robots" content="noindex,nofollow"><title>TennisWorld — Preview</title></html>';

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
            expect(body, path).toBe(HTML_WITH_META);
            expect(res.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
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
        expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await res.text()).toBe(HTML_WITH_META);
        expect(fetched).toEqual(['/sprint1.html', '/sprint1']);
    });

    it('sets X-Robots-Tag noindex, nofollow even when the asset sent a weaker tag', async () => {
        const { env } = assetsEnv({
            'Content-Type': 'text/html; charset=utf-8',
            'X-Robots-Tag': 'noindex',
        });
        const res = await worker.fetch(new Request('https://example.test/today'), env);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
        expect(await res.text()).toContain('<meta name="robots" content="noindex,nofollow">');
    });

    it('HEAD on the HTML tab paths matches GET', async () => {
        const { env } = assetsEnv({ 'Content-Type': 'text/html; charset=utf-8' });
        for (const path of ['/', '/today', '/schedule', '/picks', '/me']) {
            const get = await worker.fetch(new Request(`https://example.test${path}`), env);
            const head = await worker.fetch(new Request(`https://example.test${path}`, { method: 'HEAD' }), env);
            expect(head.status, path).toBe(get.status);
            expect(head.status, path).not.toBe(404);
            expect(await head.text(), path).toBe('');
            expect(head.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
        }
    });

    it('stamps X-Robots-Tag on an asset served through the ASSETS binding', async () => {
        const env = {
            CORS_ORIGIN: '*',
            ASSETS: {
                async fetch() {
                    return new Response('body{color:red}', {
                        status: 200,
                        headers: { 'Content-Type': 'text/css' },
                    });
                },
            },
        };
        const res = await worker.fetch(new Request('https://example.test/app.css'), env);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
        expect(await res.text()).toBe('body{color:red}');
    });

    it('leaves /rankings and unknown paths on the existing JSON 404 when no asset matches', async () => {
        const fetched = [];
        const env = {
            CORS_ORIGIN: '*',
            ASSETS: {
                async fetch(request) {
                    fetched.push(new URL(request.url).pathname);
                    return new Response('missing', { status: 404 });
                },
            },
        };
        const paths = ['/rankings', '/todayx', '/api/today', '/foo', '/today//', '/today/extra'];
        for (const path of paths) {
            const res = await worker.fetch(new Request(`https://example.test${path}`), env);
            expect(res.status, path).toBe(404);
            expect(await res.json(), path).toEqual({ error: `Unknown route: ${path}` });
            expect(res.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
        }
        const post = await worker.fetch(new Request('https://example.test/today', { method: 'POST' }), env);
        expect(post.status).toBe(404);
        expect(await post.json()).toEqual({ error: 'Unknown route: /today' });
        expect(fetched).not.toContain('/sprint1.html');
        expect(fetched).not.toContain('/api/today');
        expect(fetched).toContain('/rankings');
    });
});
