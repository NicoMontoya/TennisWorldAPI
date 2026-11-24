import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyFixtureOverlay } from './transforms/fixturesFeed.js';
import { decideGrade, replayFinals, replayHistorical } from './picksGrade.js';

const ao = JSON.parse(readFileSync(new URL('./fixtures/picks/ao2026_golden.json', import.meta.url), 'utf8'));
const paris = JSON.parse(readFileSync(new URL('./fixtures/picks/paris2025_golden.json', import.meta.url), 'utf8'));
const finals = JSON.parse(readFileSync(new URL('./fixtures/picks/finals_rr_golden.json', import.meta.url), 'utf8'));

function overlayFeed(status, extra = {}) {
    const base = {
        matchKey: 'm',
        player1Key: '10',
        player2Key: '11',
        tournamentKey: '1',
        roundId: 1,
        status: 'Not Started',
        winner: '',
        setScores: [],
    };
    const feed = {
        matchKey: 'm',
        player1Key: '10',
        player2Key: '11',
        tournamentKey: '1',
        roundId: 1,
        status,
        statusText: status,
        ...extra,
    };
    return applyFixtureOverlay([base], [feed], { now: new Date('2026-11-16T12:00:00.000Z') })[0];
}

describe('golden replay', () => {
    it('replays the golden files with 0 wrong grades', () => {
        expect(ao.some(row => /W\/O/i.test(row.score))).toBe(true);
        expect(ao.some(row => /RET|DEF/i.test(row.score))).toBe(true);
        expect(paris.some(row => /W\/O/i.test(row.score))).toBe(true);
        const historical = replayHistorical(ao) + replayHistorical(paris);
        const finalsReplay = replayFinals(finals.cases);
        const wrong = historical + finalsReplay.wrong;
        expect(wrong).toBe(0);
        const byId = Object.fromEntries(finalsReplay.reasons.map(row => [row.id, row]));
        expect(byId['rr-walkover-void']).toMatchObject({ result: 'void', voidReason: 'walkover' });
        expect(byId['rr-scoreless-winner-first-seen-pending']).toMatchObject({ result: 'pending', voidReason: '' });
        expect(byId['rr-scoreless-winner-second-refresh-void']).toMatchObject({ result: 'void', voidReason: 'walkover' });
        expect(byId['rr-cancelled-void']).toMatchObject({ result: 'void', voidReason: 'cancelled' });
        expect(byId['rr-alternate-swap-void']).toMatchObject({ result: 'void', voidReason: 'player_changed' });
        expect(byId['rr-alternate-swap-void-loser-side']).toMatchObject({ result: 'void', voidReason: 'player_changed' });
        expect(byId['rr-retirement-counts']).toMatchObject({ result: 'correct', voidReason: '' });
        expect(byId['rr-finished-no-winner-pending']).toMatchObject({ result: 'pending', voidReason: '' });
    });
});

describe('retirement before the first game', () => {
    it('grades a retirement before the first game from the recorded winner', () => {
        for (const text of ['Retired', 'Ret.', 'Finished (retired)', 'retirement', 'Retired - player1']) {
            const row = overlayFeed(text, { winner: '10', setScores: [] });
            expect(row.status, text).toBe('Finished');
            expect(row.setScores, text).toEqual([]);
            const picked = decideGrade(row, {
                picked_player_key: '10',
                player1_key: '10',
                player2_key: '11',
                scoreless_first_seen_at: null,
                scoreless_status_as_of: '',
                result: 'pending',
                void_reason: '',
            });
            expect(picked, text).toMatchObject({ result: 'correct', voidReason: '' });
            const missed = decideGrade(row, {
                picked_player_key: '11',
                player1_key: '10',
                player2_key: '11',
                scoreless_first_seen_at: 1,
                scoreless_status_as_of: '2026-11-16T12:00:00.000Z',
                result: 'pending',
                void_reason: '',
            });
            expect(missed, text).toMatchObject({ result: 'wrong', voidReason: '' });
            const again = decideGrade(row, {
                picked_player_key: '10',
                player1_key: '10',
                player2_key: '11',
                scoreless_first_seen_at: null,
                scoreless_status_as_of: '',
                result: 'correct',
                void_reason: '',
            });
            expect(again, text).toMatchObject({ result: 'correct', voidReason: '' });
        }
    });
});
