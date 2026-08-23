// backfill-rankings-history.ts
// Loads DATE-KEYED historical rankings (the full weekly ranking list for every
// Monday since 1973) into KV, so the Historical Rankings feature can show what
// the rankings were on any date — retired players included.
//
// Reads Jeff Sackmann's local dataset (../tennis_atp): every atp_rankings_*.csv
// (ranking_date,rank,player_id,points) joined to atp_players.csv for names/country.
// Groups by ranking_date, keeps the top-N per week, and POSTs one payload per
// YEAR to /api/admin/import-rankings-history (per-year storage keeps the whole
// backfill to ~55 KV writes — well under the free-tier ceiling).
//
// Prereqs:  wrangler dev on :8787 · ../tennis_atp cloned · ADMIN_SECRET in .dev.vars
// Run:      bun run scripts/backfill-rankings-history.ts [--tour ATP] [--top 200] [--dry]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here    = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const WORKER  = 'http://127.0.0.1:8787';

const argv    = process.argv.slice(2);
const dryRun  = argv.includes('--dry');
const topN    = (() => { const i = argv.indexOf('--top'); return i >= 0 ? parseInt(argv[i + 1], 10) : 200; })();
const tourArg = (() => { const i = argv.indexOf('--tour'); return i >= 0 ? argv[i + 1]?.toUpperCase() : 'ATP'; })();

const ADMIN_SECRET = (readFileSync(join(repoDir, '.dev.vars'), 'utf8')
    .match(/^ADMIN_SECRET\s*=\s*"?([^"\n]+)"?/m) || [])[1];
if (!ADMIN_SECRET) { console.error('ADMIN_SECRET not found in .dev.vars'); process.exit(1); }

const fmtDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

interface RankRow { rank: number; pid: string; points: number | null; }

async function backfill(tour: 'ATP' | 'WTA') {
    const slug = tour.toLowerCase();
    const dataDir = join(repoDir, '..', `tennis_${slug}`);
    if (!existsSync(dataDir)) { console.error(`${dataDir} not cloned — skipping ${tour}`); return; }

    // ── Player id → {name, country} ──────────────────────────────────────────
    const players = new Map<string, { name: string; country: string }>();
    for (const line of readFileSync(join(dataDir, `${slug}_players.csv`), 'utf8').trim().split('\n').slice(1)) {
        const c = line.split(',');
        const id = c[0];
        const name = `${(c[1] || '').trim()} ${(c[2] || '').trim()}`.trim();
        if (id && name) players.set(id, { name, country: (c[5] || '').trim() });
    }
    console.log(`${tour}: ${players.size} players in name index`);

    // ── Read every decade file, group rows by ranking_date ───────────────────
    const decades = ['70s', '80s', '90s', '00s', '10s', '20s', 'current'];
    const byDate = new Map<string, RankRow[]>();       // "YYYYMMDD" → rows
    for (const dec of decades) {
        const f = join(dataDir, `${slug}_rankings_${dec}.csv`);
        if (!existsSync(f)) continue;
        for (const line of readFileSync(f, 'utf8').trim().split('\n').slice(1)) {
            const c = line.split(',');
            const date = c[0], rank = parseInt(c[1], 10), pid = c[2];
            const points = c[3] ? parseInt(c[3], 10) : null;
            if (!date || !(rank > 0) || rank > topN) continue;   // keep only top-N
            let arr = byDate.get(date);
            if (!arr) { arr = []; byDate.set(date, arr); }
            arr.push({ rank, pid, points });
        }
    }
    console.log(`${tour}: ${byDate.size} weekly ranking dates read (top ${topN})`);

    // ── Assemble per-year { "YYYY-MM-DD": [ {rank,name,country,points,pid} ] } ─
    const byYear = new Map<string, Record<string, any[]>>();
    for (const [rawDate, rows] of byDate) {
        rows.sort((a, b) => a.rank - b.rank);
        const iso = fmtDate(rawDate);
        const year = iso.slice(0, 4);
        const list = rows.map(r => {
            const p = players.get(r.pid);
            return { rank: r.rank, name: p?.name || `#${r.pid}`, country: p?.country || '', points: r.points, pid: r.pid };
        });
        let y = byYear.get(year);
        if (!y) { y = {}; byYear.set(year, y); }
        y[iso] = list;
    }
    const years = Array.from(byYear.keys()).sort();
    const totalWeeks = Array.from(byYear.values()).reduce((s, y) => s + Object.keys(y).length, 0);
    console.log(`${tour}: ${years.length} years, ${totalWeeks} weeks total. Range ${years[0]}–${years[years.length - 1]}`);

    if (dryRun) {
        const sample = byYear.get('1985');
        const wk = sample && Object.keys(sample).sort()[0];
        console.log(`DRY sample 1985 week ${wk}:`, sample && sample[wk!].slice(0, 3));
        return;
    }

    // ── POST one payload per year ─────────────────────────────────────────────
    let ok = 0, fail = 0;
    for (const year of years) {
        const snapshots = byYear.get(year)!;
        try {
            const res = await fetch(`${WORKER}/api/admin/import-rankings-history`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
                body: JSON.stringify({ tour, year, snapshots }),
            });
            const j = await res.json();
            if (res.ok && j?.data?.ok) { ok++; process.stdout.write(`  ✓ ${year} (${j.data.weeks}w, ${j.data.totalDates} total)\r`); }
            else { fail++; console.error(`\n  ✗ ${year}:`, j?.error || res.status); }
        } catch (e: any) { fail++; console.error(`\n  ✗ ${year}:`, e.message); }
    }
    console.log(`\n${tour}: imported ${ok} years, ${fail} failed.`);
}

await backfill(tourArg as 'ATP' | 'WTA');
