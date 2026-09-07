// backfill-sackmann.ts
// Backfills FULL-CAREER KV ranking history from Jeff Sackmann's local dataset
// (cloned at ../tennis_atp). Reads every decade file so a player's profile chart
// shows their true ranking arc across their whole career, not just 2 recent years.
//
// Prereqs:
//   - Worker reachable (wrangler dev on :8787, or production via --worker / WORKER_URL)
//   - ../tennis_atp cloned (git clone https://github.com/Kadantte/tennis_atp)
//   - ADMIN_SECRET in env or .dev.vars (not required for --dry)
//
// Run:  bun run scripts/backfill-sackmann.ts --tour ATP [--dry] [--worker URL] [--limit N] [--offset N]
//
// WTA is out of scope for the ATP runbook. Clone tennis_wta and pass --tour WTA
// only if you later want that tour.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    argFlag, argValue, kvWriteNote, loadAdminSecret, resolveDataDir, resolveWorkerUrl,
} from './lib/backfill-cli.ts';

const here    = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const BATCH   = 40;                                  // players per import POST

const argv    = process.argv.slice(2);
const dryRun  = argFlag(argv, '--dry');
const tourArg = (argValue(argv, '--tour') || 'ATP').toUpperCase();
const limit   = (() => { const v = argValue(argv, '--limit'); return v != null ? parseInt(v, 10) : Infinity; })();
const offset  = (() => { const v = argValue(argv, '--offset'); return v != null ? parseInt(v, 10) : 0; })();
const WORKER  = resolveWorkerUrl(argv);
const ADMIN_SECRET = loadAdminSecret(repoDir, { required: !dryRun });

if (tourArg !== 'ATP' && tourArg !== 'WTA') {
    console.error('--tour must be ATP or WTA');
    process.exit(1);
}

console.log(`Worker: ${WORKER}${dryRun ? '  [dry-run]' : ''}`);

// ── Name normalization for Sackmann ↔ RapidAPI matching ─────────────────────────
function norm(s: string): string {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
        .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fmtDate(d: string): string {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; // YYYYMMDD → YYYY-MM-DD
}

// Minimal CSV split (Sackmann files are plain, no quoted commas).
function rows(text: string): string[][] {
    return text.trim().split('\n').slice(1).map(l => l.split(','));
}

async function backfill(tour: 'ATP' | 'WTA') {
    const slug = tour.toLowerCase();
    const dataDir = resolveDataDir(repoDir, tour, argv);
    if (!existsSync(dataDir)) {
        console.log(`\n── ${tour}: skipped — ${dataDir} not cloned`);
        return;
    }
    console.log(`\n── ${tour} ───────────────────────────────── (${dataDir})`);

    // 1. Sackmann players: id → normalized "First Last". Track name collisions so
    //    we don't map an ambiguous name to the wrong career.
    const players = readFileSync(join(dataDir, `${slug}_players.csv`), 'utf8');
    const ph = players.trim().split('\n')[0].split(',');
    const iId = ph.indexOf('player_id'), iF = ph.indexOf('name_first'), iL = ph.indexOf('name_last');
    const sidToName = new Map<string, string>();
    const nameToSids = new Map<string, string[]>();
    for (const r of rows(players)) {
        const sid = r[iId]?.trim();
        if (!sid) continue;
        const nm = norm(`${r[iF] || ''} ${r[iL] || ''}`);
        sidToName.set(sid, nm);
        if (!nameToSids.has(nm)) nameToSids.set(nm, []);
        nameToSids.get(nm)!.push(sid);
    }
    console.log(`  Sackmann players: ${sidToName.size}`);

    // 2. Our ranked roster from the Worker: normalized name → playerKey (RapidAPI).
    let stand: { ok?: boolean; data?: Array<{ playerKey: string; name: string }>; error?: string };
    try {
        const res = await fetch(`${WORKER}/api/standings?tour=${tour}`);
        stand = await res.json() as typeof stand;
        if (!res.ok || stand?.ok === false) {
            console.error(`  standings fetch failed: ${stand?.error || res.status}`);
            return;
        }
    } catch (e: any) {
        console.error(`  standings fetch failed (${WORKER}): ${e.message}`);
        return;
    }
    const nameToKey = new Map<string, string>();
    for (const p of (stand.data ?? [])) nameToKey.set(norm(p.name), p.playerKey);
    console.log(`  Roster (standings): ${nameToKey.size}`);

    // 3. Map the Sackmann ids we actually need → our playerKey (skip ambiguous names).
    const sidToKey = new Map<string, string>();
    let ambiguous = 0;
    for (const [nm, key] of nameToKey) {
        const sids = nameToSids.get(nm);
        if (!sids) continue;
        if (sids.length > 1) { ambiguous++; continue; }  // name collision — can't disambiguate w/o dob
        sidToKey.set(sids[0], key);
    }
    console.log(`  Matched roster→Sackmann: ${sidToKey.size}` + (ambiguous ? `  (${ambiguous} skipped as ambiguous)` : ''));

    // 4. Walk every ranking decade file; collect full career per matched player.
    const decades = ['70s', '80s', '90s', '00s', '10s', '20s', 'current'];
    const histories: Record<string, Array<{ date: string; rank: number }>> = {};
    let scanned = 0, used = 0;
    for (const dec of decades) {
        const file = join(dataDir, `${slug}_rankings_${dec}.csv`);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        const rh = text.trim().split('\n')[0].split(',');
        const iDate = rh.indexOf('ranking_date'), iRank = rh.indexOf('rank'), iPlayer = rh.indexOf('player');
        for (const r of rows(text)) {
            scanned++;
            const key = sidToKey.get(r[iPlayer]?.trim());
            if (!key) continue;
            const rawDate = r[iDate]?.trim();
            const rank = parseInt(r[iRank]);
            if (!rawDate || rawDate.length < 8 || !(rank > 0)) continue;
            (histories[key] = histories[key] || []).push({ date: fmtDate(rawDate), rank });
            used++;
        }
        console.log(`  ${dec}: scanned ${scanned.toLocaleString()}, kept ${used.toLocaleString()}`);
    }

    // 5. Dedup per date (best rank), sort ascending.
    for (const key of Object.keys(histories)) {
        const byDate = new Map<string, number>();
        for (const { date, rank } of histories[key]) {
            if (!byDate.has(date) || rank < byDate.get(date)!) byDate.set(date, rank);
        }
        histories[key] = Array.from(byDate, ([date, rank]) => ({ date, rank }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    const allKeys = Object.keys(histories);
    const keys = allKeys.slice(offset, offset + (Number.isFinite(limit) ? limit : allKeys.length));
    const totalPts = keys.reduce((s, k) => s + histories[k].length, 0);
    console.log(`  Players with career history: ${allKeys.length}  (${keys.length} in this slice, offset=${offset})`);
    console.log(`  Points in slice: ${totalPts.toLocaleString()}`);
    if (keys.length) {
        const deepest = keys.slice().sort((a, b) => histories[b].length - histories[a].length)[0];
        console.log(`  Deepest: playerKey ${deepest} — ${histories[deepest].length} weeks, ${histories[deepest][0].date} → ${histories[deepest].at(-1)!.date}`);
    }
    console.log(`  ${kvWriteNote(keys.length)}  (1 write per player; reads do not count)`);

    if (dryRun) { console.log('  [dry] skipping import'); return; }
    if (!keys.length) return;

    // 6. Import in batches.
    let written = 0, errors = 0;
    for (let i = 0; i < keys.length; i += BATCH) {
        const chunk = keys.slice(i, i + BATCH);
        const body = { tour, histories: Object.fromEntries(chunk.map(k => [k, histories[k]])) };
        const res = await fetch(`${WORKER}/api/admin/import-rank-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
            body: JSON.stringify(body),
        });
        // Worker wraps handler results as { ok, data: { written, errors } }.
        const j = await res.json() as { ok: boolean; error?: string; data?: { written?: number; errors?: number } };
        if (!res.ok || !j.ok) { console.error(`  batch ${i}-${i + chunk.length} failed: ${j.error || res.status}`); errors += chunk.length; continue; }
        written += j.data?.written ?? 0; errors += j.data?.errors ?? 0;
        process.stdout.write(`\r  imported ${Math.min(i + BATCH, keys.length)}/${keys.length}`);
    }
    console.log(`\n  ✓ Written: ${written}, Errors: ${errors}`);
}

await backfill(tourArg as 'ATP' | 'WTA');
console.log('\nDone.');
