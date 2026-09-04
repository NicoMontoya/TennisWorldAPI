#!/usr/bin/env node
// ===================================
// upcomingDraws — list tournaments whose main draw is about to start
// ===================================
// The trigger end of the draw-capture workflow. Run it (daily, or when you want
// to prep upcoming events); for each tournament starting within the window it
// prints the tournamentId (for /api/draws + the BRACKET_SLOTS key), the start
// date, and the exact drawSnapshot command to capture that draw's order.
//
// WORKFLOW
//   1. node scripts/upcomingDraws.mjs           # what's coming in the next 3 days
//   2. for each row, find its Wikipedia men's/women's-singles page, then:
//        node scripts/drawSnapshot.mjs "<wiki page title>" "<key>"
//   3. paste the emitted entry into BOTH bracketSlots.js files (API + UI)
//   4. bump the draws cache key if replacing an existing entry
//   Re-run daily through Day 1 so qualifier slots fill as qualifying resolves.
//
// USAGE
//   node scripts/upcomingDraws.mjs [--days N] [--tour ATP|WTA|both]
//
// Reads RAPIDAPI_KEY from .dev.vars (same source the Worker uses in dev).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const getArg = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const days     = parseInt(getArg('--days', '3'), 10);
const tourArg  = (getArg('--tour', 'both')).toLowerCase();
const tours    = tourArg === 'both' ? ['atp', 'wta'] : [tourArg];

const here = dirname(fileURLToPath(import.meta.url));
const devVars = readFileSync(join(here, '..', '.dev.vars'), 'utf8');
const KEY = (devVars.match(/^RAPIDAPI_KEY\s*=\s*"?([^"\n]+)"?/m) || [])[1];
if (!KEY) { console.error('RAPIDAPI_KEY not found in .dev.vars'); process.exit(1); }

const HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
const BASE = `https://${HOST}/tennis/v2`;
const headers = { 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': HOST, 'User-Agent': 'TennisWorld-upcomingDraws' };

const now   = new Date();
const start = new Date(now); start.setHours(0, 0, 0, 0);
const end   = new Date(start); end.setDate(end.getDate() + days);
const year  = now.getFullYear();

// A tournament "starts" on its calendar date; keep those inside [today, today+days].
function keyFor(name, tour) {
    // First distinctive word of the name → the BRACKET_SLOTS substring key.
    const word = (name || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] || 'event';
    return `${word}|${year}|${tour.toUpperCase()}`;
}

// Fetch a full year's calendar — paginated (upstream caps pageSize at 500).
async function fetchCalendar(tour) {
    const all = [];
    for (let pageNo = 1; pageNo <= 6; pageNo++) {
        let res;
        try {
            res = await fetch(`${BASE}/${tour}/tournament/calendar/${year}?pageSize=500&pageNo=${pageNo}`, { headers });
        } catch (e) { console.error(`calendar ${tour} pageNo=${pageNo} fetch failed: ${e.message}`); break; }
        if (!res.ok) { console.error(`calendar ${tour} ${year} pageNo=${pageNo}: HTTP ${res.status}`); break; }
        const cal = await res.json();
        const page = cal?.data || [];
        all.push(...page);
        if (page.length < 500) break;   // hasNextPage is unreliable; short page = last
    }
    return all;
}

const rows = [];
for (const tour of tours) {
    for (const t of await fetchCalendar(tour)) {
        if (!t.date) continue;
        const d = new Date(t.date);
        if (d >= start && d <= end) {
            rows.push({ tour: tour.toUpperCase(), id: t.id, name: t.name, date: t.date.slice(0, 10), tier: t.tier || '' });
        }
    }
}

rows.sort((a, b) => a.date.localeCompare(b.date) || a.tour.localeCompare(b.tour));

if (!rows.length) {
    console.log(`No tournaments start in the next ${days} day(s).`);
    process.exit(0);
}

console.log(`\nTournaments starting within ${days} day(s) (as of ${start.toISOString().slice(0, 10)}):\n`);
for (const r of rows) {
    const key = keyFor(r.name, r.tour);
    console.log(`• ${r.date}  ${r.tour}  [${r.tier}]  ${r.name}`);
    console.log(`    tournamentId: ${r.id}   →  /api/draws?tournamentKey=${r.id}&tour=${r.tour}`);
    console.log(`    capture:  node scripts/drawSnapshot.mjs "<Wikipedia singles page title>" "${key}"`);
    console.log(`    find page: https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(r.name + ' ' + year + ' singles')}\n`);
}
console.log(`Then paste each entry into BOTH src/bracketSlots.js and TennisWorldUI/bracketSlots.js, and bump the draws cache key.\n`);
