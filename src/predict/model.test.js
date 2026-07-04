// ===================================
// Unit tests for the win-probability model (v0.1)
// ===================================
// Runs with the built-in Node test runner (no deps):
//   node --test src/predict/model.test.js
// Matches the repo's *.test.js convention (see TennisWorldUI/scoreFormatters.test.js).
//
// Proves: probA+probB===1, equal-input→0.50, symmetry predict(A,B)===1-predict(B,A),
// monotonicity in rank, AND that surface and H2H actually move the output (not
// just rank) — the explicit advisor requirement.

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { predict } from './model.js';

const EPS = 1e-6;

// Helper: a balanced base case where every feature is neutral.
function evenInput(extra = {}) {
    return {
        rankA: 10, rankB: 10,
        surfaceWinPctA: 0.7, surfaceWinPctB: 0.7,
        h2hWinsA: 3, h2hWinsB: 3,
        ...extra,
    };
}

test('probA + probB === 1 for every response', () => {
    for (const inp of [
        evenInput(),
        evenInput({ rankA: 1, rankB: 200 }),
        evenInput({ surfaceWinPctA: 0.9, surfaceWinPctB: 0.2 }),
        { rankA: null, rankB: 50, surfaceWinPctA: null, surfaceWinPctB: null, h2hWinsA: null, h2hWinsB: null },
    ]) {
        const r = predict(inp);
        assert.ok(Math.abs((r.probA + r.probB) - 1) < EPS, `sum=${r.probA + r.probB}`);
    }
});

test('equal inputs → 0.50 / 0.50', () => {
    const r = predict(evenInput());
    assert.ok(Math.abs(r.probA - 0.5) < EPS, `probA=${r.probA}`);
    assert.ok(Math.abs(r.probB - 0.5) < EPS, `probB=${r.probB}`);
});

test('symmetry: predict(A,B).probA === predict(B,A).probB', () => {
    const ab = predict(evenInput({ rankA: 5, rankB: 40, surfaceWinPctA: 0.8, surfaceWinPctB: 0.5, h2hWinsA: 6, h2hWinsB: 2 }));
    const ba = predict(evenInput({ rankA: 40, rankB: 5, surfaceWinPctA: 0.5, surfaceWinPctB: 0.8, h2hWinsA: 2, h2hWinsB: 6 }));
    assert.ok(Math.abs(ab.probA - ba.probB) < EPS, `${ab.probA} vs ${ba.probB}`);
    assert.ok(Math.abs(ab.probB - ba.probA) < EPS, `${ab.probB} vs ${ba.probA}`);
    // Equivalent statement: predict(A,B) === 1 − predict(B,A)
    assert.ok(Math.abs(ab.probA - (1 - ba.probA)) < EPS);
});

test('rank: stronger (lower number) A → probA > 0.5, monotonic in gap', () => {
    const base = predict(evenInput());                         // 0.50
    const mild = predict(evenInput({ rankA: 8, rankB: 12 }));   // small edge
    const big  = predict(evenInput({ rankA: 1, rankB: 100 }));  // large edge
    assert.ok(mild.probA > base.probA, 'mild rank edge raises probA');
    assert.ok(big.probA  > mild.probA, 'bigger rank gap raises probA further');
});

test('surface ALONE moves the output (rank & H2H held equal)', () => {
    const base   = predict(evenInput());                                       // 0.50
    const better = predict(evenInput({ surfaceWinPctA: 0.85, surfaceWinPctB: 0.45 }));
    const worse  = predict(evenInput({ surfaceWinPctA: 0.45, surfaceWinPctB: 0.85 }));
    assert.ok(better.probA > base.probA + 0.02, `surface should lift probA: ${better.probA} vs ${base.probA}`);
    assert.ok(worse.probA  < base.probA - 0.02, `surface should drop probA: ${worse.probA} vs ${base.probA}`);
});

test('H2H ALONE moves the output (rank & surface held equal)', () => {
    const base    = predict(evenInput());                              // 0.50
    const winning = predict(evenInput({ h2hWinsA: 9, h2hWinsB: 1 }));
    const losing  = predict(evenInput({ h2hWinsA: 1, h2hWinsB: 9 }));
    assert.ok(winning.probA > base.probA + 0.01, `H2H should lift probA: ${winning.probA}`);
    assert.ok(losing.probA  < base.probA - 0.01, `H2H should drop probA: ${losing.probA}`);
});

test('output clamped to [0.02, 0.98]', () => {
    const extreme = predict({ rankA: 1, rankB: 2000, surfaceWinPctA: 1, surfaceWinPctB: 0, h2hWinsA: 50, h2hWinsB: 0 });
    assert.ok(extreme.probA <= 0.98 + EPS, `probA=${extreme.probA}`);
    assert.ok(extreme.probB >= 0.02 - EPS, `probB=${extreme.probB}`);
});

test('confidence + partial: all signals → high, missing rank → low', () => {
    const full = predict(evenInput());
    assert.equal(full.confidence, 'high');
    assert.equal(full.partial, false);

    const noRank = predict(evenInput({ rankA: null }));
    assert.equal(noRank.confidence, 'low');   // missing rank is the worst gap
    assert.equal(noRank.partial, true);

    const noH2H = predict(evenInput({ h2hWinsA: null, h2hWinsB: null }));
    assert.notEqual(noH2H.confidence, 'high'); // missing H2H → not high
    assert.equal(noH2H.partial, true);
});

test('drivers: 1–3 human-readable signals, names attributed correctly', () => {
    const r = predict(evenInput({ rankA: 1, rankB: 80, nameA: 'Sinner', nameB: 'Nadal' }));
    assert.ok(r.drivers.length >= 1 && r.drivers.length <= 3);
    assert.ok(r.drivers.some(d => d.includes('Sinner')), `drivers: ${JSON.stringify(r.drivers)}`);
    assert.ok(r.modelVersion === 'v0.1');
});
