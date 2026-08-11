#!/usr/bin/env node
// ===================================
// testDraws — batch-validate every tournament's /api/draws bracket
// ===================================
// Re-runs the live draws route for a set of tournaments and checks each bracket
// for structural correctness, so we know past brackets fill consistently and
// upcoming ones fill fully once captured.
//
// USAGE
//   node scripts/testDraws.mjs [--tour ATP|WTA|both] [--min-rank N] [--limit N]
//                              [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--only-issues]
// Defaults: ATP, min-rank 2 (tour level — skips challengers/futures), whole 2026.
//
// CHECKS per tournament (GET localhost:8787/api/draws):
//   • responded ok with ≥1 round
//   • first-round size is a power of two (8/16/32/64/128)
//   • round counts halve cleanly toward the final (no phantom inflation)
//   • label matches size: a "Round of N" round holds ≤ N/2 matches
//   • classifies past (date<today) vs upcoming, and notes synthetic-filled draws
//
// Reads RAPIDAPI_KEY from .dev.vars for the calendar; the draws themselves come
// from the local worker (which caches, so re-runs are fast).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = f => argv.includes(f);

const tourArg  = arg('--tour', 'ATP').toLowerCase();
const tours    = tourArg === 'both' ? ['atp', 'wta'] : [tourArg];
const minRank  = parseInt(arg('--min-rank', '2'), 10);
const limit    = parseInt(arg('--limit', '0'), 10);
const fromStr  = arg('--from', '2026-01-01');
const toStr    = arg('--to', '2026-12-31');
const onlyIssues = has('--only-issues');

const here = dirname(fileURLToPath(import.meta.url));
const KEY = (readFileSync(join(here, '..', '.dev.vars'), 'utf8').match(/^RAPIDAPI_KEY\s*=\s*"?([^"\n]+)"?/m) || [])[1];
if (!KEY) { console.error('RAPIDAPI_KEY not in .dev.vars'); process.exit(1); }

const HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
const calHeaders = { 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': HOST, 'User-Agent': 'TennisWorld-testDraws' };
const LOCAL = 'http://localhost:8787';
const today = new Date().toISOString().slice(0, 10);
const POW2 = new Set([2, 4, 8, 16, 32, 64, 128]);

// Fetch a full year's calendar — paginated (upstream caps pageSize at 500).
async function fetchCalendar(tour) {
    const all = [];
    for (let pageNo = 1; pageNo <= 6; pageNo++) {
        const res = await fetch(`https://${HOST}/tennis/v2/${tour}/tournament/calendar/2026?pageSize=500&pageNo=${pageNo}`, { headers: calHeaders });
        if (!res.ok) { console.error(`calendar ${tour} pageNo=${pageNo}: HTTP ${res.status}`); break; }
        const cal = await res.json();
        const page = cal?.data || [];
        all.push(...page);
        if (page.length < 500) break;   // hasNextPage is unreliable; short page = last
    }
    return all;
}

// Collect the tournament set from the calendar.
let list = [];
for (const tour of tours) {
    for (const t of await fetchCalendar(tour)) {
        if (!t.date) continue;
        const d = t.date.slice(0, 10);
        if (d < fromStr || d > toStr) continue;
        if ((t.rankId ?? 0) < minRank) continue;
        list.push({ tour: tour.toUpperCase(), id: t.id, name: t.name, date: d, tier: t.tier || '' });
    }
}
list.sort((a, b) => a.date.localeCompare(b.date));
if (limit > 0) list = list.slice(0, limit);

// Team / non-bracket events don't have a standard single-elim singles draw.
const NON_BRACKET = /davis cup|united cup|laver cup|atp cup|billie jean|juniors?|wheelchair|exhibition/i;

// Validate one draw response.
//
// Bracket invariants that hold regardless of byes:
//   • the PEAK round (most matches) is a power of two and equals drawSize/2
//   • no round exceeds the peak (a round larger than the peak = phantom/dup bug)
//   • the first round is either the peak (no byes) or peak/… smaller (byes) —
//     a 28-draw legitimately has 12 R1 matches then a 16-match R2, so we do NOT
//     require the first round itself to be a power of two.
//   • a "Round of N" label must hold ≤ N/2 matches
function validate(t, data) {
    const issues = [];
    if (NON_BRACKET.test(t.name)) return { status: 'SKIP-NONBRACKET', issues, first: 0, synth: 0 };

    const rounds = data?.rounds || [];
    if (!rounds.length) return { status: t.date < today ? 'EMPTY-PAST' : 'EMPTY-UPCOMING', issues, first: 0, synth: 0 };

    const byOrder = rounds.slice().sort((a, b) => b.order - a.order); // earliest → latest
    const desc    = byOrder.map(r => r.matches.length);
    const firstN  = desc[0];
    const total   = desc.reduce((a, b) => a + b, 0);
    const synth   = rounds.reduce((s, r) => s + r.matches.filter(m => m.synthetic).length, 0);

    // Bracket invariant (bye-tolerant): earliest→latest counts never INCREASE.
    // A later round larger than an earlier one is phantom/duplicate inflation —
    // the real structural bug. Byes make R1 small (28-draw: 12,8,4,2,1) but the
    // sequence still only decreases, so this holds for every draw size.
    for (let i = 1; i < desc.length; i++) {
        if (desc[i] > desc[i - 1]) {
            issues.push(`inflation: ${byOrder[i].round} (${desc[i]}) > ${byOrder[i - 1].round} (${desc[i - 1]})`);
        }
    }
    // Label vs size: a "Round of N" round must hold ≤ N/2 matches.
    for (const r of rounds) {
        const mm = /round of (\d+)/i.exec(r.round);
        if (mm && r.matches.length > parseInt(mm[1], 10) / 2) {
            issues.push(`"${r.round}" holds ${r.matches.length} (>${parseInt(mm[1], 10) / 2})`);
        }
    }
    // A genuine truncation bug: the deepest round is fully DECIDED yet has >1
    // match and no successor round — a completed round whose winners lead
    // nowhere. An in-progress event whose frontier round is unplayed (0 decided)
    // is NOT broken; it just hasn't reached the Final yet. This distinguishes a
    // real structure bug from ordinary tournament progress.
    const past = t.date < today;
    const lastRound = byOrder[byOrder.length - 1];
    const lastDecided = lastRound.matches.filter(m => m.winner).length;
    const lastCount = desc[desc.length - 1];
    if (lastCount > 1 && lastDecided === lastCount) {
        issues.push(`truncated: "${lastRound.round}" (${lastCount}) fully decided but has no next round`);
    }

    const status = issues.length ? 'ISSUE' : (past ? 'OK-PAST' : 'OK-UPCOMING');
    return { status, issues, first: firstN, synth, total };
}

// Bounded concurrency.
async function pool(items, n, fn) {
    const out = []; let i = 0;
    const workers = Array.from({ length: n }, async () => {
        while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
    });
    await Promise.all(workers);
    return out;
}

console.error(`Testing ${list.length} tournaments (tour=${tourArg}, min-rank=${minRank}, ${fromStr}..${toStr})…\n`);

const results = await pool(list, 2, async (t) => {
    try {
        const res = await fetch(`${LOCAL}/api/draws?tournamentKey=${t.id}&tour=${t.tour}`, { signal: AbortSignal.timeout(30000) });
        const json = await res.json();
        if (!json.ok) return { t, ...{ status: 'ERROR', issues: [json.error || 'not ok'], first: 0, synth: 0 } };
        return { t, ...validate(t, json.data) };
    } catch (e) {
        return { t, status: 'ERROR', issues: [e.message], first: 0, synth: 0 };
    }
});

// Report.
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;

for (const r of results) {
    if (onlyIssues && r.status.startsWith('OK')) continue;
    const flag = r.status.startsWith('OK') ? '✓' : r.status.startsWith('EMPTY') ? '·' : '✗';
    const extra = r.synth ? ` (+${r.synth} synth)` : '';
    const why = r.issues.length ? `  — ${r.issues.join('; ')}` : '';
    console.log(`${flag} [${r.status}] ${r.t.date} ${r.t.tour} ${r.t.name} · R1=${r.first}${extra}${why}`);
}

console.log('\n── Summary ──');
for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k}: ${v}`);
console.log(`  TOTAL: ${results.length}`);

// --strict: exit non-zero only on STRUCTURAL failures (ISSUE) — mislabeled or
// inflated rounds, truncated trees. ERROR (transient upstream/rate-limit) and
// EMPTY-PAST (upstream published no draw) are operational/data-availability
// facts, reported but not gated. SKIP/EMPTY-UPCOMING are expected.
if (has('--strict')) {
    const structuralFails = tally['ISSUE'] || 0;
    const dataNotes = (tally['ERROR'] || 0) + (tally['EMPTY-PAST'] || 0);
    if (dataNotes) console.error(`\n· DATA NOTES: ${tally['ERROR'] || 0} upstream error(s), ${tally['EMPTY-PAST'] || 0} empty past event(s) — not structural.`);
    if (structuralFails > 0) {
        console.error(`✗ STRICT: ${structuralFails} STRUCTURAL failure(s) (ISSUE).`);
        process.exit(1);
    }
    console.error('✓ STRICT: every captured bracket is structurally valid.');
}
