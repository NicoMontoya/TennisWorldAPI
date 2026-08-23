// backfill-vintage-legends.ts
// Precomputes "vintage curve" data (cumulative wins/matches/titles/Masters/Slams
// vs age) for retired greats from Jeff Sackmann's full match archive (../tennis_atp,
// atp_matches_*.csv back to 1968), so the home-page Vintage Curves can plot
// Federer, Nadal, McEnroe, Borg… alongside current players.
//
// Inclusion: every player with >= --min career tour-level wins (default 300 →
// ~182 players, all notable names across every era). Same {age,w,m,t,ms,gs}
// shape the live RapidAPI path produces (src/routes/vintage.js), so the client
// treats legends identically. Legend ids are 's'+SackmannId.
//
// Prereqs:  wrangler dev on :8787 · ../tennis_atp cloned · ADMIN_SECRET in .dev.vars
// Run:      bun run scripts/backfill-vintage-legends.ts [--tour ATP] [--min 300] [--dry]

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here    = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const WORKER  = 'http://127.0.0.1:8787';

const argv    = process.argv.slice(2);
const dryRun  = argv.includes('--dry');
const minWins = (() => { const i = argv.indexOf('--min'); return i >= 0 ? parseInt(argv[i + 1], 10) : 300; })();
const tourArg = (() => { const i = argv.indexOf('--tour'); return i >= 0 ? argv[i + 1]?.toUpperCase() : 'ATP'; })();
const BATCH   = 20;

const ADMIN_SECRET = (readFileSync(join(repoDir, '.dev.vars'), 'utf8')
    .match(/^ADMIN_SECRET\s*=\s*"?([^"\n]+)"?/m) || [])[1];
if (!ADMIN_SECRET) { console.error('ADMIN_SECRET not found in .dev.vars'); process.exit(1); }

const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
const TOUR_LEVELS = new Set(['G', 'M', 'A', 'F']); // Slam, Masters, ATP tour, Tour Finals (excl. Davis Cup 'D')

// Sackmann atp_matches_*.csv columns (0-indexed): 4 level, 5 date, 7 winner_id, 15 loser_id, 25 round
const C = { level: 4, date: 5, winner: 7, loser: 15, round: 25 };

function isoFromYmd(d: string) { return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; }

async function backfill(tour: 'ATP' | 'WTA') {
    const slug = tour.toLowerCase();
    const dataDir = join(repoDir, '..', `tennis_${slug}`);
    if (!existsSync(dataDir)) { console.error(`${dataDir} not cloned — skipping ${tour}`); return; }

    const matchFiles = readdirSync(dataDir)
        .filter(f => /^atp_matches_\d{4}\.csv$/.test(f.replace('atp_', `${slug}_`)) || /^atp_matches_\d{4}\.csv$/.test(f))
        .filter(f => new RegExp(`^${slug}_matches_\\d{4}\\.csv$`).test(f))
        .sort();
    if (!matchFiles.length) { console.error(`No ${slug}_matches_YYYY.csv in ${dataDir}`); return; }

    // ── Players: id → {name, dob(iso), ioc} ──────────────────────────────────
    const players = new Map<string, { name: string; dob: string | null; ioc: string }>();
    for (const line of readFileSync(join(dataDir, `${slug}_players.csv`), 'utf8').trim().split('\n').slice(1)) {
        const c = line.split(',');
        const name = `${(c[1] || '').trim()} ${(c[2] || '').trim()}`.trim();
        const dob = c[4] && /^\d{8}$/.test(c[4]) ? isoFromYmd(c[4]) : null;
        if (c[0] && name) players.set(c[0], { name, dob, ioc: (c[5] || '').trim() });
    }

    // ── Pass 1: career tour-level wins per player → inclusion set ─────────────
    const wins = new Map<string, number>();
    for (const f of matchFiles) {
        for (const line of readFileSync(join(dataDir, f), 'utf8').trim().split('\n').slice(1)) {
            const c = line.split(',');
            const w = c[C.winner];
            if (w) wins.set(w, (wins.get(w) || 0) + 1);
        }
    }
    const legendIds = new Set([...wins].filter(([, n]) => n >= minWins).map(([id]) => id));
    console.log(`${tour}: ${legendIds.size} players with >= ${minWins} career wins (from ${matchFiles.length} match files)`);

    // ── Pass 2: collect each legend's matches ────────────────────────────────
    const perPlayer = new Map<string, { date: string; level: string; round: string; won: boolean }[]>();
    for (const id of legendIds) perPlayer.set(id, []);
    for (const f of matchFiles) {
        for (const line of readFileSync(join(dataDir, f), 'utf8').trim().split('\n').slice(1)) {
            const c = line.split(',');
            const date = c[C.date], level = c[C.level], round = c[C.round];
            const w = c[C.winner], l = c[C.loser];
            if (!date) continue;
            if (legendIds.has(w)) perPlayer.get(w)!.push({ date, level, round, won: true });
            if (legendIds.has(l)) perPlayer.get(l)!.push({ date, level, round, won: false });
        }
    }

    // ── Build curves ──────────────────────────────────────────────────────────
    const curves: Record<string, any> = {};
    const legends: { id: string; name: string; countryAcr: string; wins: number }[] = [];
    let skipped = 0;
    for (const id of legendIds) {
        const p = players.get(id);
        if (!p || !p.dob) { skipped++; continue; }   // need dob for age axis
        const birthMs = new Date(p.dob).getTime();
        const matches = perPlayer.get(id)!.sort((a, b) => a.date.localeCompare(b.date));

        const points: any[] = [];
        let w = 0, m = 0, t = 0, ms = 0, gs = 0;
        for (const mt of matches) {
            m++;
            if (mt.won) {
                w++;
                if (mt.round === 'F' && TOUR_LEVELS.has(mt.level)) {
                    t++;
                    if (mt.level === 'M') ms++;
                    if (mt.level === 'G') gs++;
                }
            }
            const age = Math.round(((new Date(isoFromYmd(mt.date)).getTime() - birthMs) / MS_PER_YEAR) * 100) / 100;
            points.push({ age, w, m, t, ms, gs });
        }
        const sId = 's' + id;
        curves[sId] = {
            player: { id: sId, name: p.name, countryAcr: p.ioc, birthday: p.dob, legend: true },
            points,
            totals: { wins: w, matches: m, titles: t, masters: ms, slams: gs },
        };
        legends.push({ id: sId, name: p.name, countryAcr: p.ioc, wins: w });
    }
    legends.sort((a, b) => b.wins - a.wins);
    console.log(`${tour}: built ${legends.length} legend curves (${skipped} skipped for missing dob). Top:`,
        legends.slice(0, 5).map(l => `${l.name}(${l.wins})`).join(', '));

    if (dryRun) {
        const fed = curves['s103819'];
        console.log('DRY Federer sample — totals:', fed?.totals, '| points:', fed?.points?.length,
            '| last:', fed?.points?.[fed.points.length - 1]);
        return;
    }

    // ── Import in batches (legends index sent with the first batch) ───────────
    const ids = Object.keys(curves);
    let ok = 0, fail = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const body: any = { tour, curves: Object.fromEntries(chunk.map(id => [id, curves[id]])) };
        if (i === 0) body.legends = legends;   // whole index once
        try {
            const res = await fetch(`${WORKER}/api/admin/import-vintage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
                body: JSON.stringify(body),
            });
            const j = await res.json();
            if (res.ok && j?.data?.ok) { ok += chunk.length; process.stdout.write(`  ✓ ${ok}/${ids.length}\r`); }
            else { fail += chunk.length; console.error(`\n  ✗ batch ${i}:`, j?.error || res.status); }
        } catch (e: any) { fail += chunk.length; console.error(`\n  ✗ batch ${i}:`, e.message); }
    }
    console.log(`\n${tour}: imported ${ok} legend curves, ${fail} failed.`);
}

await backfill(tourArg as 'ATP' | 'WTA');
