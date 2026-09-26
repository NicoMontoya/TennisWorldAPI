// backfill-vintage-rank-by-age.ts
// Precomputes Vintage Curves rank-by-age from Jeff Sackmann's local rankings
// (../tennis_atp, top 200, same files as scripts/backfill-rankings-history.ts).
// One small permanent KV record per vintage-roster player. Dry-run unless --write.
//
// The public GET does not scan year blobs (those are ~0.7MB and would blow the
// Workers free-tier CPU budget). It reads the record this script writes.
//
// Join:
//   legend roster id s123 → Sackmann player_id 123 → dob in atp_players.csv
//   numeric roster id     → normalized name → unique Sackmann player with a dob
// Birth dates are used to build the series and are not stored.
//
// Prereqs: ../tennis_atp cloned. Roster mode also needs the Worker (vintage
// legends already imported). --ids mode is offline.
// Run:
//   bun run scripts/backfill-vintage-rank-by-age.ts --tour ATP [--ids s103819,s101948] [--dry]
//   bun run scripts/backfill-vintage-rank-by-age.ts --tour ATP --write [--worker URL] [--limit N] [--offset N]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    argFlag, argValue, kvWriteNote, loadAdminSecret, resolveDataDir, resolveWorkerUrl,
} from './lib/backfill-cli.ts';
import { buildPlayerRankRecord, canonicalPlayerKey } from '../src/rankByAge.js';

const here    = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const argv    = process.argv.slice(2);
const write   = argFlag(argv, '--write');
const dryFlag = argFlag(argv, '--dry');
const tourArg = (argValue(argv, '--tour') || 'ATP').toUpperCase();
const idsArg  = argValue(argv, '--ids');
const limit   = (() => { const v = argValue(argv, '--limit'); return v != null ? parseInt(v, 10) : Infinity; })();
const offset  = (() => { const v = argValue(argv, '--offset'); return v != null ? parseInt(v, 10) : 0; })();
const BATCH   = 20;

if (write && dryFlag) {
    console.error('Pass either --write or --dry, not both.');
    process.exit(1);
}
if (tourArg !== 'ATP' && tourArg !== 'WTA') {
    console.error('--tour must be ATP or WTA');
    process.exit(1);
}
if (tourArg === 'WTA') {
    console.log('WTA ranking history is not loaded. Nothing to compute.');
    console.log('Estimated KV writes: 0.');
    process.exit(0);
}

const needWorker = write || !idsArg;
const WORKER = needWorker ? resolveWorkerUrl(argv) : '';
const ADMIN_SECRET = loadAdminSecret(repoDir, { required: write });

console.log(write
    ? `Worker: ${WORKER}  [write]`
    : `Dry-run${WORKER ? ` (roster from ${WORKER})` : ' (offline --ids)'}. No KV writes. Pass --write to import.`);

const isoFromYmd = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

function norm(s: string): string {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface CsvPlayer { id: string; name: string; dob: string | null; }

function loadPlayers(dataDir: string): Map<string, CsvPlayer> {
    const players = new Map<string, CsvPlayer>();
    const text = readFileSync(join(dataDir, 'atp_players.csv'), 'utf8');
    const lines = text.trim().split('\n');
    const header = lines[0].split(',');
    const iId = header.indexOf('player_id');
    const iF = header.indexOf('name_first');
    const iL = header.indexOf('name_last');
    const iDob = header.indexOf('dob');
    for (const line of lines.slice(1)) {
        const c = line.split(',');
        const id = c[iId]?.trim();
        const name = `${(c[iF] || '').trim()} ${(c[iL] || '').trim()}`.trim();
        if (!id || !name) continue;
        const rawDob = c[iDob]?.trim() || '';
        const dob = /^\d{8}$/.test(rawDob) ? isoFromYmd(rawDob) : null;
        players.set(id, { id, name, dob });
    }
    return players;
}

interface Resolved {
    playerKey: string;
    pid: string | null;
    name: string | null;
    dob: string | null;
    status: 'ok' | 'no-birthday' | 'unmatched' | 'ambiguous' | 'unknown-id';
}

function resolveEntry(id: string, name: string | null, players: Map<string, CsvPlayer>, byName: Map<string, CsvPlayer[]>): Resolved {
    const key = canonicalPlayerKey(id);
    if (!key) return { playerKey: id, pid: null, name, dob: null, status: 'unknown-id' };
    if (key.startsWith('s')) {
        const p = players.get(key.slice(1));
        if (!p) return { playerKey: key, pid: null, name, dob: null, status: 'unknown-id' };
        if (!p.dob) return { playerKey: key, pid: p.id, name: name || p.name, dob: null, status: 'no-birthday' };
        return { playerKey: key, pid: p.id, name: name || p.name, dob: p.dob, status: 'ok' };
    }
    const matches = byName.get(norm(name || '')) || [];
    if (matches.length > 1) return { playerKey: key, pid: null, name, dob: null, status: 'ambiguous' };
    if (matches.length === 0) return { playerKey: key, pid: null, name, dob: null, status: 'unmatched' };
    const p = matches[0];
    if (!p.dob) return { playerKey: key, pid: p.id, name: name || p.name, dob: null, status: 'no-birthday' };
    return { playerKey: key, pid: p.id, name: name || p.name, dob: p.dob, status: 'ok' };
}

// Analytics spot-check for the Day-1 file (through 2026-06-08). Skipped when
// the local calendar is a different span, so a newer CSV can still be imported.
const SPOT: Record<string, { ranks: Record<number, number>; omit: number[] }> = {
    s103819: { ranks: { 22: 1, 23: 1, 24: 1, 25: 1, 26: 1, 28: 1, 35: 4 }, omit: [] },
    s101948: { ranks: { 22: 1, 23: 1, 24: 1, 25: 1, 26: 1, 27: 1 }, omit: [32] },
    s101736: { ranks: { 25: 1, 29: 1, 36: 150 }, omit: [37] },
};

function spotCheck(records: Record<string, any>, asOf: string | null, rankingsStart: string | null) {
    if (asOf !== '2026-06-08' || rankingsStart !== '1973-08-27') {
        console.log(`Spot-check guard skipped (calendar ${rankingsStart} → ${asOf}).`);
        return;
    }
    const problems: string[] = [];
    let checked = 0;
    for (const [key, spec] of Object.entries(SPOT)) {
        const rec = records[key];
        if (!rec) continue;
        checked++;
        const byAge = new Map<number, any>((rec.years || []).map((y: any) => [y.age, y]));
        for (const [age, rank] of Object.entries(spec.ranks)) {
            const got = byAge.get(Number(age));
            if (!got || got.rank !== rank) problems.push(`${key} age ${age}: expected rank ${rank}, got ${got ? got.rank : 'omitted'}`);
        }
        for (const age of spec.omit) {
            if (byAge.has(age)) problems.push(`${key} age ${age}: expected omission (under 13 ranked weeks)`);
        }
        if (key === 's103819') {
            const y22 = byAge.get(22);
            if (!y22 || y22.weeksAtRank !== 26.9 || y22.rankedWeeks !== 52.3) {
                problems.push(`s103819 age 22 weeks: expected 26.9 of 52.3, got ${y22?.weeksAtRank} of ${y22?.rankedWeeks}`);
            }
        }
    }
    if (!checked) {
        console.log('Spot-check guard: Federer / Sampras / Agassi were not in this player set.');
        return;
    }
    if (problems.length) {
        console.error('Spot-check guard failed:');
        for (const p of problems) console.error('  ' + p);
        process.exit(1);
    }
    console.log(`Spot-check guard passed (${checked} of Federer / Sampras / Agassi).`);
}

const dataDir = resolveDataDir(repoDir, 'ATP', argv);
if (!existsSync(dataDir)) {
    console.error(`${dataDir} not cloned. Pass --data-dir or clone tennis_atp next to this repo.`);
    process.exit(1);
}

const players = loadPlayers(dataDir);
const byName = new Map<string, CsvPlayer[]>();
for (const p of players.values()) {
    const n = norm(p.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n)!.push(p);
}

let roster: { id: string; name: string | null }[] = [];
if (idsArg) {
    roster = idsArg.split(',').map(s => s.trim()).filter(Boolean).map(id => {
        const key = canonicalPlayerKey(id.startsWith('s') || id.startsWith('S') ? id : `s${id}`);
        const p = key?.startsWith('s') ? players.get(key.slice(1)) : undefined;
        return { id: key || id, name: p?.name || null };
    });
    console.log(`Offline ids: ${roster.length}`);
} else {
    const res = await fetch(`${WORKER}/api/vintage-roster?tour=ATP`);
    const body = await res.json() as { ok?: boolean; error?: string; data?: { roster?: { id: string; name?: string }[] } };
    if (!res.ok || body.ok === false || !body.data?.roster) {
        console.error(`vintage-roster fetch failed: ${body.error || res.status}`);
        process.exit(1);
    }
    roster = body.data.roster.map(r => ({ id: String(r.id), name: r.name || null }));
    console.log(`Vintage roster: ${roster.length}`);
}

const resolved: Resolved[] = roster.map(r => resolveEntry(r.id, r.name, players, byName));
const wanted = new Set(resolved.filter(r => r.status === 'ok' && r.pid).map(r => r.pid!));

const dates = new Set<string>();
const ranks = new Map<string, Map<string, number>>();
for (const pid of wanted) ranks.set(pid, new Map());

const decades = ['70s', '80s', '90s', '00s', '10s', '20s', 'current'];
for (const dec of decades) {
    const file = join(dataDir, `atp_rankings_${dec}.csv`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    for (const line of lines.slice(1)) {
        const c = line.split(',');
        const raw = c[0];
        if (!raw || raw.length < 8) continue;
        dates.add(raw);
        const bucket = ranks.get(c[2]);
        if (!bucket) continue;
        const rank = parseInt(c[1], 10);
        if (!(rank >= 1 && rank <= 200)) continue;
        const iso = isoFromYmd(raw);
        const prev = bucket.get(iso);
        if (prev == null || rank < prev) bucket.set(iso, rank);
    }
}

const rankingDates = [...dates].sort().map(isoFromYmd);
console.log(`Ranking calendar: ${rankingDates.length} weeks, ${rankingDates[0]} → ${rankingDates[rankingDates.length - 1]}`);

const records: Record<string, any> = {};
const notes = { unmatched: [] as string[], ambiguous: [] as string[], unknown: [] as string[] };
for (const r of resolved) {
    if (r.status === 'unmatched') { notes.unmatched.push(r.name || r.playerKey); continue; }
    if (r.status === 'ambiguous') { notes.ambiguous.push(r.name || r.playerKey); continue; }
    if (r.status === 'unknown-id') { notes.unknown.push(r.playerKey); continue; }
    if (r.status === 'no-birthday') {
        records[r.playerKey] = buildPlayerRankRecord({
            name: r.name, birthday: null, ranksByDate: {}, rankingDates,
        });
        continue;
    }
    const byDate: Record<string, number> = {};
    for (const [date, rank] of ranks.get(r.pid!) || []) byDate[date] = rank;
    records[r.playerKey] = buildPlayerRankRecord({
        name: r.name, birthday: r.dob, ranksByDate: byDate, rankingDates,
    });
}

const asOf = rankingDates[rankingDates.length - 1] || null;
const rankingsStart = rankingDates[0] || null;
spotCheck(records, asOf, rankingsStart);

const allKeys = Object.keys(records);
const keys = allKeys.slice(offset, offset + (Number.isFinite(limit) ? limit : allKeys.length));
console.log(`Resolved ${allKeys.length} records (${keys.length} in this slice, offset=${offset}).`);
console.log(`  no-birthday: ${allKeys.filter(k => records[k].reason === 'no-birthday').length}`);
console.log(`  no-ranking-history: ${allKeys.filter(k => records[k].reason === 'no-ranking-history').length}`);
console.log(`  unmatched (not written): ${notes.unmatched.length}${notes.unmatched.length ? ' — ' + notes.unmatched.slice(0, 12).join(', ') : ''}`);
console.log(`  ambiguous (not written): ${notes.ambiguous.length}${notes.ambiguous.length ? ' — ' + notes.ambiguous.slice(0, 12).join(', ') : ''}`);
console.log(`  unknown id (not written): ${notes.unknown.length}`);
console.log(kvWriteNote(keys.length) + '  1 permanent put per player. GET stays at 0 writes.');

for (const key of ['s103819', 's101948', 's101736']) {
    const rec = records[key];
    if (!rec) continue;
    const brief = (rec.years || []).filter((y: any) => [22, 25, 28, 29, 35, 36].includes(y.age))
        .map((y: any) => `${y.age}:#${y.rank}`).join(' ');
    console.log(`  ${rec.name} ${key}: ${rec.years.length} age years ${brief}`);
}

if (!write) {
    console.log('[dry-run] skipping import.');
    process.exit(0);
}

let written = 0, errors = 0;
for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH);
    const body = { tour: 'ATP', records: Object.fromEntries(chunk.map(k => [k, records[k]])) };
    const res = await fetch(`${WORKER}/api/admin/import-vintage-rank-by-age`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
        body: JSON.stringify(body),
    });
    const j = await res.json() as { ok?: boolean; error?: string; data?: { written?: number; errors?: number } };
    if (!res.ok || !j.ok) {
        console.error(`  batch ${i} failed: ${j.error || res.status}`);
        errors += chunk.length;
        continue;
    }
    written += j.data?.written ?? 0;
    errors += j.data?.errors ?? 0;
    process.stdout.write(`\r  imported ${Math.min(i + BATCH, keys.length)}/${keys.length}`);
}
console.log(`\nWritten: ${written}, errors: ${errors}.`);
if (errors) process.exit(1);
