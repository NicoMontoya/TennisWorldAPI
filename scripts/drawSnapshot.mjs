#!/usr/bin/env node
// ===================================
// drawSnapshot — capture an official draw's ORDER before/at main-draw start
// ===================================
// WHY THIS EXISTS
//   The RapidAPI feed gives us matchups but (a) omits draw position/order
//   entirely, (b) is incomplete before a tournament (only scheduled matches;
//   qualifier slots empty), and (c) can mislabel round sizes. So we cannot
//   render a correct, ordered main draw from the API alone — especially before
//   play starts. The fix is an authoritative ORDER override (src/bracketSlots.js
//   BRACKET_SLOTS), captured at draw release.
//
// STRATEGY
//   The most reliable, parseable, non-bot-blocked source of an ORDERED draw is
//   Wikipedia's raw bracket wikitext (?action=raw). Its {{NN TeamBracket ...}}
//   templates list every slot as `RD1-teamNN=` lines in exact top-to-bottom
//   order, with seed/WC/Q/LL/PR in the paired `RD1-seedNN=` line. Official
//   tour sites (atptour.com, tournament sites) are Cloudflare-403 to server
//   fetches; Wikipedia is not. Consecutive team lines pair into matches
//   (01/02, 03/04, …). We parse them in document order → the exact bracket.
//
//   Run this at draw release (draw ceremony is ~1-2 days before Day 1; re-run
//   daily through Day 1 to fill qualifier names as they resolve), paste the
//   emitted entry into BOTH src/bracketSlots.js and TennisWorldUI/bracketSlots.js.
//
// USAGE
//   node scripts/drawSnapshot.mjs "<wikipedia_page_title>" <key>
//   e.g.
//   node scripts/drawSnapshot.mjs "2026 Mubadala Citi DC Open – Men's singles" "washington|2026|ATP"
//
//   --json   emit raw {index,p1,p2,seed1,seed2} rows instead of the slot entry
//
// OUTPUT
//   A `"key": [["P1","P2"], …]` line ready to paste into BRACKET_SLOTS, plus a
//   human-readable numbered match list on stderr for eyeball validation.

const [, , pageTitleArg, keyArg, ...flags] = process.argv;
const asJson = flags.includes('--json');

if (!pageTitleArg || !keyArg) {
    console.error('usage: node scripts/drawSnapshot.mjs "<wikipedia page title>" "tournament|year|TOUR" [--json]');
    process.exit(2);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 TennisWorld-drawSnapshot';
const rawUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitleArg.replace(/ /g, '_'))}?action=raw`;

// Strip a wikitext player cell to a matchable surname token.
//   "{{flagicon|AUS}} [[Alex de Minaur|A de Minaur]]" → "de Minaur"
//   "{{flagicon|USA}} [[Ben Shelton]]"                → "Shelton"
// We keep the last 1-2 capitalised words so compound names survive
// ("de Minaur", "Davidovich Fokina", "Ugo Carabelli").
function cleanTeam(raw) {
    if (!raw) return '';
    let s = raw
        .replace(/\{\{[^}]*\}\}/g, '')                 // {{flagicon|..}}
        .replace(/'''?/g, '')                          // bold
        .replace(/<small>.*?<\/small>/g, '')           // seed annotations
        .replace(/<[^>]+>/g, '')                       // stray tags
        .trim();
    const link = s.match(/\[\[([^\]]+)\]\]/);          // [[Target|Display]] or [[Name]]
    if (link) {
        const parts = link[1].split('|');
        s = (parts[1] || parts[0]).trim();             // prefer display text
        // display like "A de Minaur" — drop a leading single-initial token
        const toks = s.split(/\s+/);
        // Drop a leading initials token: "A" (de Minaur), "TM" (Etcheverry), "J.".
        if (toks.length > 1 && /^[A-Z]{1,3}\.?$/.test(toks[0])) toks.shift();
        s = toks.join(' ');
    }
    return s.replace(/\s+/g, ' ').trim();
}

function cleanSeed(raw) {
    if (!raw) return '';
    return raw.replace(/\{\{[^}]*\}\}/g, '').replace(/<[^>]+>/g, '').replace(/'''?/g, '').trim();
}

const res = await fetch(rawUrl, { headers: { 'User-Agent': UA } });
if (!res.ok) {
    console.error(`fetch failed: HTTP ${res.status} for ${rawUrl}`);
    process.exit(1);
}
const wikitext = await res.text();

// The MAIN draw is split across multiple bracket templates (e.g. a 32-draw is
// two half-brackets), and EACH restarts its slot numbering at RD1-team01. So we
// must process the file block-by-block: a new block begins whenever the team
// number resets to a value we've already seen in the current block. Qualifying
// draws use the single-digit `RD1-team1` form, which this two-digit regex skips
// — cleanly separating main draw from qualies. Seeds attach to the team of the
// same number WITHIN the same block (never across halves).
const lineRe = /\|\s*RD1-(team|seed)(\d{2})\s*=\s*(.*)/;

// In the wikitext each slot is written seed-then-team (RD1-seedNN before
// RD1-teamNN), so we buffer the pending seed by number and let the team consume
// it on arrival. Pending seeds survive a block reset — the seed that precedes a
// new block's team01 belongs to that incoming team.
const blocks = [];
let cur = [];                 // [{num, team, seedRaw}]
const seenNums = new Set();
const pendingSeed = new Map();

for (const line of wikitext.split('\n')) {
    const mm = line.match(lineRe);
    if (!mm) continue;
    const [, kind, num, val] = mm;

    if (kind === 'seed') {
        pendingSeed.set(num, val);
    } else {                          // team
        if (seenNums.has(num)) {      // numbering reset → new bracket block
            if (cur.length) blocks.push(cur);
            cur = [];
            seenNums.clear();
        }
        seenNums.add(num);
        const seedRaw = pendingSeed.has(num) ? pendingSeed.get(num) : null;
        pendingSeed.delete(num);
        cur.push({ num, team: cleanTeam(val), seedRaw });
    }
}
if (cur.length) blocks.push(cur);

// Keep only main-draw blocks (a half is ≥ 8 slots); concatenate in document
// order (top half, then bottom half) and pair consecutive slots into matches.
const mainSlots = blocks.filter(b => b.length >= 8).flat();

if (mainSlots.length < 2) {
    console.error('no two-digit RD1-team main-draw blocks found — is this a tennis main-draw page?');
    process.exit(1);
}
if (mainSlots.length % 2 !== 0) {
    console.error(`warning: odd slot count (${mainSlots.length}) — a slot may have failed to parse; validate the list below carefully.`);
}

const matches = [];
for (let i = 0; i + 1 < mainSlots.length; i += 2) {
    matches.push({
        index:  matches.length,
        p1:     mainSlots[i].team,
        p2:     mainSlots[i + 1].team,
        seed1:  cleanSeed(mainSlots[i].seedRaw),
        seed2:  cleanSeed(mainSlots[i + 1].seedRaw),
    });
}

// Human-readable validation list → stderr (won't pollute the paste output).
console.error(`\n${keyArg}  —  ${matches.length} first-round matches (validate against the official draw):`);
for (const mm of matches) {
    const s1 = mm.seed1 ? `[${mm.seed1}] ` : '';
    const s2 = mm.seed2 ? ` [${mm.seed2}]` : '';
    console.error(`  ${String(mm.index + 1).padStart(2)}. ${s1}${mm.p1}  vs  ${mm.p2}${s2}`);
}
console.error('');

if (asJson) {
    console.log(JSON.stringify(matches, null, 2));
} else {
    const pairs = matches.map(mm => `[${JSON.stringify(mm.p1)}, ${JSON.stringify(mm.p2)}]`).join(', ');
    console.log(`${JSON.stringify(keyArg)}: [${pairs}],`);
}
