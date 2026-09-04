// backfill-h2h-matches.ts
// Builds per-player CAREER match logs in KV from Jeff Sackmann's local match archive
// (../tennis_atp/atp_matches_*.csv, 1968→present) so /api/h2h returns the COMPLETE
// head-to-head — including retired opponents the live "last 200 matches" API can
// never surface.
//
// Scope: only players queryable in the UI need logs — the union of
//   (a) the active standings roster (RapidAPI keys, name-matched), and
//   (b) vintage legends (>= --min career wins, keyed 's'+SackmannId — same scheme
//       as scripts/backfill-vintage-legends.ts).
// For every match where EITHER side is in that set, the match is appended to that
// player's log with the opponent resolved to a key + name.
//
// Prereqs (real run):  wrangler dev on :8787 · ../tennis_atp cloned · ADMIN_SECRET in .dev.vars
// Run:  bun run scripts/backfill-h2h-matches.ts [--tour ATP] [--min 300] [--dry]
//   --dry : needs NO worker/creds — builds logs for the legend set only (all from
//           CSV) and prints Sampras vs Agassi (should be 20–14, 34 total) as an
//           end-to-end pipeline proof.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here    = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const WORKER  = 'http://127.0.0.1:8787';
const BATCH   = 20;

const argv    = process.argv.slice(2);
const dryRun  = argv.includes('--dry');
const minWins = (() => { const i = argv.indexOf('--min'); return i >= 0 ? parseInt(argv[i + 1], 10) : 300; })();
const tourArg = (() => { const i = argv.indexOf('--tour'); return i >= 0 ? argv[i + 1]?.toUpperCase() : 'ATP'; })();

const ADMIN_SECRET = dryRun ? '' : (readFileSync(join(repoDir, '.dev.vars'), 'utf8')
    .match(/^ADMIN_SECRET\s*=\s*"?([^"\n]+)"?/m) || [])[1];
if (!dryRun && !ADMIN_SECRET) { console.error('ADMIN_SECRET not found in .dev.vars'); process.exit(1); }

// Sackmann atp_matches_*.csv columns (0-indexed).
const C = { tid: 0, tname: 1, surface: 2, date: 5, mnum: 6, wid: 7, wname: 10, lid: 15, lname: 18, score: 23, round: 25 };

function norm(s: string): string {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
        .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function isoDate(d: string): string {
    return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}
function normSurface(s: string): string {
    const c = (s || '').toLowerCase();
    if (c.includes('clay'))  return 'clay';
    if (c.includes('grass')) return 'grass';
    return 'hard';   // hard + carpet + unknown → hard (matches src/routes/h2h.js normSurface)
}
// Minimal CSV split (Sackmann files are plain, no quoted commas).
function rows(text: string): string[][] {
    return text.trim().split('\n').slice(1).map(l => l.split(','));
}

interface MatchRec {
    matchKey: string; date: string; tournamentName: string; surface: string;
    round: string; opponentKey: string; opponentName: string; won: boolean; score: string;
}

async function backfill(tour: 'ATP' | 'WTA') {
    const slug = tour.toLowerCase();
    const dataDir = join(repoDir, '..', `tennis_${slug}`);
    if (!existsSync(dataDir)) { console.error(`${dataDir} not cloned — skipping ${tour}`); return; }

    const matchFiles = readdirSync(dataDir)
        .filter(f => new RegExp(`^${slug}_matches_\\d{4}\\.csv$`).test(f))
        .sort();
    if (!matchFiles.length) { console.error(`No ${slug}_matches_YYYY.csv in ${dataDir}`); return; }
    console.log(`\n── ${tour} ── ${matchFiles.length} match files (${matchFiles[0]} → ${matchFiles.at(-1)})`);

    // ── Sackmann players: id → "First Last" (display) and normalized name ─────────
    const idToName    = new Map<string, string>();
    const idToNorm    = new Map<string, string>();
    const normToIds   = new Map<string, string[]>();
    for (const r of rows(readFileSync(join(dataDir, `${slug}_players.csv`), 'utf8'))) {
        const id = r[0]?.trim(); if (!id) continue;
        const name = `${(r[1] || '').trim()} ${(r[2] || '').trim()}`.trim();
        const nm = norm(name);
        idToName.set(id, name);
        idToNorm.set(id, nm);
        if (!normToIds.has(nm)) normToIds.set(nm, []);
        normToIds.get(nm)!.push(id);
    }
    console.log(`  Sackmann players: ${idToName.size}`);

    // ── Pass 1: career wins per player → legend inclusion set ─────────────────────
    const wins = new Map<string, number>();
    for (const f of matchFiles) {
        for (const r of rows(readFileSync(join(dataDir, f), 'utf8'))) {
            const w = r[C.wid]?.trim();
            if (w) wins.set(w, (wins.get(w) || 0) + 1);
        }
    }
    const legendIds = new Set([...wins].filter(([, n]) => n >= minWins).map(([id]) => id));
    console.log(`  Legends (>= ${minWins} wins): ${legendIds.size}`);

    // ── Key mapping: sackmannId → playerKey ──────────────────────────────────────
    // Start with legend keys ('s'+id), then overlay active-roster RapidAPI keys so a
    // still-active great (Djokovic…) uses the key their live profile is queried with.
    const idToKey = new Map<string, string>();
    for (const id of legendIds) idToKey.set(id, 's' + id);

    if (!dryRun) {
        const stand = await (await fetch(`${WORKER}/api/standings?tour=${tour}`)).json() as
            { data?: Array<{ playerKey: string; name: string }> };
        let matched = 0, ambiguous = 0;
        for (const p of (stand.data ?? [])) {
            const ids = normToIds.get(norm(p.name));
            if (!ids) continue;
            if (ids.length > 1) { ambiguous++; continue; }  // name collision — skip w/o dob
            idToKey.set(ids[0], String(p.playerKey));        // active key overrides legend key
            matched++;
        }
        console.log(`  Active roster matched → Sackmann: ${matched}` + (ambiguous ? `  (${ambiguous} ambiguous skipped)` : ''));
    } else {
        console.log('  [dry] skipping /api/standings — legend set only');
    }

    // loggedSids = players we build a log FOR (opponents only need a key, not a log).
    const loggedSids = new Set(idToKey.keys());

    // ── Pass 2: append each match to the logs of any logged participant ───────────
    const logs = new Map<string, MatchRec[]>();
    const push = (sid: string, oppSid: string, won: boolean, r: string[]) => {
        const key = idToKey.get(sid); if (!key) return;
        const oppKey  = idToKey.get(oppSid) || ('s' + oppSid);
        const oppName = idToName.get(oppSid) || (won ? r[C.lname] : r[C.wname]) || '';
        (logs.get(key) || logs.set(key, []).get(key)!).push({
            matchKey:       `${r[C.tid]}-${r[C.mnum]}`,
            date:           isoDate(r[C.date]?.trim() || ''),
            tournamentName: (r[C.tname] || '').trim(),
            surface:        normSurface(r[C.surface]),
            round:          (r[C.round] || '').trim(),
            opponentKey:    oppKey,
            opponentName:   oppName,
            won,
            score:          (r[C.score] || '').trim(),
        });
    };
    for (const f of matchFiles) {
        for (const r of rows(readFileSync(join(dataDir, f), 'utf8'))) {
            const w = r[C.wid]?.trim(), l = r[C.lid]?.trim();
            if (!w || !l) continue;
            if (loggedSids.has(w)) push(w, l, true,  r);
            if (loggedSids.has(l)) push(l, w, false, r);
        }
    }
    const keys = [...logs.keys()];
    const totalRecs = keys.reduce((s, k) => s + logs.get(k)!.length, 0);
    console.log(`  Built logs: ${keys.length} players, ${totalRecs.toLocaleString()} match records`);

    // ── Dry-run pipeline proof: Sampras vs Agassi (both legends) ─────────────────
    if (dryRun) {
        const SAMPRAS = 's101948', AGASSI = 's101736';
        const log = logs.get(SAMPRAS) || [];
        const vsAgassi = log.filter(m => m.opponentKey === AGASSI);
        const sampWins = vsAgassi.filter(m => m.won).length;
        console.log('\n  PROOF — Sampras vs Agassi (from KV-bound logs):');
        console.log(`    total meetings: ${vsAgassi.length}   Sampras ${sampWins} – ${vsAgassi.length - sampWins} Agassi`);
        console.log('    sample:', JSON.stringify(vsAgassi[0]));
        console.log('    expected: 34 total, 20–14 Sampras');
        return;
    }

    // ── Real run: POST logs in batches ───────────────────────────────────────────
    let ok = 0, fail = 0;
    for (let i = 0; i < keys.length; i += BATCH) {
        const chunk = keys.slice(i, i + BATCH);
        const body = { tour, logs: Object.fromEntries(chunk.map(k => [k, logs.get(k)])) };
        try {
            const res = await fetch(`${WORKER}/api/admin/import-matches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
                body: JSON.stringify(body),
            });
            const j = await res.json() as { ok?: boolean; data?: { written?: number }; error?: string };
            if (res.ok && j?.ok) { ok += chunk.length; process.stdout.write(`\r  imported ${Math.min(i + BATCH, keys.length)}/${keys.length}`); }
            else { fail += chunk.length; console.error(`\n  ✗ batch ${i}:`, j?.error || res.status); }
        } catch (e: any) { fail += chunk.length; console.error(`\n  ✗ batch ${i}:`, e.message); }
    }
    console.log(`\n  ✓ imported ${ok} player logs, ${fail} failed.`);
}

await backfill(tourArg as 'ATP' | 'WTA');
console.log('\nDone.');
