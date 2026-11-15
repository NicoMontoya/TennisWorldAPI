import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';
import { createMemoryD1 } from '../d1Memory.js';
import { rememberTournaments } from '../d1Store.js';
import { resetQuotaStopStateForTests } from '../quotaStop.js';

const FINALS_ID = '501';
const PAGE_SIZE = 100;

function envFor() {
    const store = new Map();
    return {
        CORS_ORIGIN: '*',
        RAPIDAPI_KEY: 'super-secret-rapid-key',
        DEMO_MODE: 'false',
        RAPIDAPI_HARD_STOP: 'on',
        RAPIDAPI_DAILY_CALL_CAP: '20',
        D1_DAILY_WRITE_BUDGET: '20000',
        DB: createMemoryD1(),
        TENNIS_CACHE: {
            async get(key, type) {
                const raw = store.get(key);
                if (raw == null) return null;
                if (type === 'json' || type?.type === 'json') {
                    try { return JSON.parse(raw); } catch { return raw; }
                }
                return raw;
            },
            async put(key, value) { store.set(key, value); },
            async delete(key) { store.delete(key); },
        },
    };
}

function row(id, name, rankId) {
    return {
        id,
        date: '2026-11-16T18:00:00.000Z',
        roundId: 8,
        tournament: {
            id: name.includes('Finals') ? Number(FINALS_ID) : 800,
            name,
            rankId,
        },
        player1Id: id,
        player2Id: id + 5000,
        player1: { id, name: `A ${id}` },
        player2: { id: id + 5000, name: `B ${id}` },
    };
}

function jsonRes(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'x-ratelimit-requests-remaining': '100',
        },
    });
}

// Page 1 is a full singles page: challengers, one ITF row, and a copy of a
// Finals id that the tournament endpoint also returns. Page 2 is the next
// ITF page the old two-page walk would have requested.
function saturatedFeed() {
    const finals = [11, 12, 13].map(id => row(id, 'Nitto ATP Finals', 7));
    const page1 = [];
    for (let i = 0; i < PAGE_SIZE - 2; i++) page1.push(row(1000 + i, `Challenger ${i}`, 1));
    page1.push(row(11, 'Challenger duplicate', 1));
    page1.push(row(9001, 'ITF Monastir', 0));
    const page2 = [];
    for (let i = 0; i < PAGE_SIZE; i++) page2.push(row(2000 + i, `ITF ${i}`, 0));
    return { finals, page1, page2 };
}

function installFetch(feed) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/tournament/calendar')) {
            throw new Error('calendar fetch is not in the fixtures budget');
        }
        if (u.includes(`/fixtures/tournament/${FINALS_ID}`)) {
            return jsonRes({ data: feed.finals, hasNextPage: false });
        }
        if (/[?&]pageNo=2(?:&|$)/.test(u)) {
            return jsonRes({ data: feed.page2, hasNextPage: true });
        }
        return jsonRes({ data: feed.page1, hasNextPage: true });
    });
    return calls;
}

function rapidCount(env) {
    return (env.DB._tables.call_tally || []).find(row => row.provider === 'rapidapi')?.count ?? 0;
}

describe('fixtures tour events inside the two-call budget', () => {
    beforeEach(() => {
        resetQuotaStopStateForTests();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        delete globalThis.fetch;
        delete globalThis.caches;
        vi.restoreAllMocks();
    });

    it('keeps ATP Finals when the general feed is saturated, without an extra upstream call', async () => {
        const feed = saturatedFeed();
        const bare = envFor();
        const bareCalls = installFetch(feed);
        const saturated = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), bare);
        const saturatedBody = await saturated.json();
        expect(saturated.status).toBe(200);
        expect(saturatedBody.ok).toBe(true);
        expect(bareCalls).toHaveLength(2);
        expect(bareCalls.every(url => url.includes('/atp/fixtures?') || url.includes('/atp/fixtures/'))).toBe(true);
        expect(bareCalls.some(url => /pageNo=1/.test(url))).toBe(true);
        expect(bareCalls.some(url => /pageNo=2/.test(url))).toBe(true);
        expect(bareCalls.some(url => url.includes('/fixtures/tournament/'))).toBe(false);
        expect(bareCalls.some(url => url.includes('/tournament/calendar'))).toBe(false);
        expect(saturatedBody.data.some(row => row.tournamentName === 'Nitto ATP Finals')).toBe(false);
        expect(saturatedBody.data.some(row => row.matchKey === '12' || row.matchKey === '13')).toBe(false);
        expect(rapidCount(bare)).toBe(2);

        const stored = envFor();
        const now = new Date().toISOString();
        await rememberTournaments(stored, 'ATP', [
            { id: 42, name: 'Test Open', tier: 'ATP 250', date: now },
            { id: 77, name: 'Lyon Challenger', tier: 'Challenger 75', date: now },
            { id: Number(FINALS_ID), name: 'Nitto ATP Finals', tier: 'Finals', date: now },
        ]);
        const calls = installFetch(feed);
        const res = await worker.fetch(new Request('https://example.test/api/fixtures?tour=ATP'), stored);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.asOf).toBeUndefined();

        const finals = body.data.filter(row => row.tournamentName === 'Nitto ATP Finals');
        expect(finals.map(row => row.matchKey)).toEqual(['11', '12', '13']);
        expect(finals.every(row => row.tier === 'tour' && row.startsAtUtc === '2026-11-16T18:00:00.000Z')).toBe(true);
        expect(body.data.filter(row => row.matchKey === '11')).toHaveLength(1);

        const tiers = body.data.map(row => row.tier);
        const firstChallenger = tiers.indexOf('challenger');
        const firstItf = tiers.indexOf('itf');
        expect(firstChallenger).toBe(finals.length);
        expect(firstItf).toBeGreaterThan(firstChallenger);
        expect(tiers.slice(firstItf).every(tier => tier === 'itf')).toBe(true);

        expect(calls).toHaveLength(bareCalls.length);
        expect(calls).toHaveLength(2);
        expect(rapidCount(stored)).toBe(rapidCount(bare));
        expect(calls.filter(url => url.includes(`/fixtures/tournament/${FINALS_ID}`))).toHaveLength(1);
        expect(calls.filter(url => /pageNo=1/.test(url))).toHaveLength(1);
        expect(calls.some(url => /pageNo=2/.test(url))).toBe(false);
        expect(calls.some(url => url.includes('/fixtures/tournament/42'))).toBe(false);
        expect(calls.some(url => url.includes('/tournament/calendar'))).toBe(false);
    });
});
