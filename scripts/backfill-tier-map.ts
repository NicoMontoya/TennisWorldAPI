// backfill-tier-map.ts
// Pre-warms the vintage-curve tier map (tournamentId → rankId, keyed by
// tour+year) directly into KV, bypassing the live Worker request path.
//
// Why this exists: getTierMap() in src/routes/vintage.js computes this map
// on-demand per player-vintage request. After fixing calendar()'s pagination
// bug (it was truncating each year to ~201 of ~900 tournaments), a full year
// now takes ~5 sequential page fetches instead of 1 — so a player with a long
// career (e.g. Djokovic, 23 seasons) needs ~100+ RapidAPI calls to build their
// tier map from a cold cache. Fired inside one live request, that blows past
// Cloudflare's per-request subrequest ceiling partway through and silently
// truncates title/Masters/Slam counts (observed: only the player's *earliest*
// years' titles counted, everything after the cutoff dropped to 0).
//
// The tier map is keyed by (tour, year) only — NOT by player — so pre-warming
// it once benefits every player's vintage curve, not just one. This script
// computes it the same way getTierMap does (paginate until an empty page) but
// from a normal Node/Bun process with no subrequest cap, then writes each
// year's map straight into the TENNIS_CACHE KV namespace in the exact shape
// cache.js's get()/set() expect, with the same 30-day TTL the route uses.
//
// Prereqs: RAPIDAPI_KEY + KV namespace id in .dev.vars / wrangler.toml,
//          wrangler authenticated (`wrangler whoami`).
// Run:     bun run scripts/backfill-tier-map.ts [--tour ATP] [--from 1996] [--to 2026] [--dry]

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here    = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');

const argv    = process.argv.slice(2);
const dryRun  = argv.includes('--dry');
const tour    = ((): string => { const i = argv.indexOf('--tour'); return i >= 0 ? argv[i + 1].toUpperCase() : 'ATP'; })();
const fromYr  = ((): number => { const i = argv.indexOf('--from'); return i >= 0 ? parseInt(argv[i + 1], 10) : 1996; })();
const toYr    = ((): number => { const i = argv.indexOf('--to');   return i >= 0 ? parseInt(argv[i + 1], 10) : new Date().getFullYear(); })();

const devVars = readFileSync(join(repoDir, '.dev.vars'), 'utf8');
const RAPIDAPI_KEY = (devVars.match(/^RAPIDAPI_KEY\s*=\s*"?([^"\n]+)/m) || [])[1];
if (!RAPIDAPI_KEY) { console.error('RAPIDAPI_KEY not found in .dev.vars'); process.exit(1); }

// TENNIS_CACHE namespace id — from wrangler.toml [[kv_namespaces]].
const nsMatch = readFileSync(join(repoDir, 'wrangler.toml'), 'utf8')
    .match(/\[\[kv_namespaces\]\][^\[]*id\s*=\s*"([^"]+)"/);
const NAMESPACE_ID = nsMatch?.[1];
if (!NAMESPACE_ID) { console.error('Could not find KV namespace id in wrangler.toml'); process.exit(1); }

const HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
const BASE = `https://${HOST}/tennis/v2`;
const TTL_TIERMAP = 30 * 24 * 60 * 60; // matches src/routes/vintage.js

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rapidFetch(path: string, attempt = 1): Promise<any> {
    const res = await fetch(`${BASE}${path}`, {
        headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY!, 'X-RapidAPI-Host': HOST, 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.status === 429 && attempt <= 6) {
        await sleep(400 * 2 ** attempt);
        return rapidFetch(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`${res.status} on ${path}`);
    return res.json();
}

// Mirrors the fixed rapidAPI.calendar(): page until an empty page, not a
// short one (upstream caps real page size at ~201 regardless of pageSize).
async function fetchYearCalendar(year: number): Promise<any[]> {
    const all: any[] = [];
    for (let pageNo = 1; pageNo <= 8; pageNo++) {
        const json = await rapidFetch(`/${tour.toLowerCase()}/tournament/calendar/${year}?pageSize=500&pageNo=${pageNo}`);
        const page = json?.data || [];
        if (!page.length) break;
        all.push(...page);
        await sleep(200);
    }
    return all;
}

async function main() {
    const years = [];
    for (let y = fromYr; y <= toYr; y++) years.push(y);
    console.log(`${tour}: pre-warming tier map for ${years.length} years (${fromYr}-${toYr})`);

    const tmpDir = mkdtempSync(join(tmpdir(), 'tw-tiermap-'));
    let written = 0, skipped = 0;

    for (const year of years) {
        const cal = await fetchYearCalendar(year);
        const yearMap: Record<string, number> = {};
        for (const t of cal) if (t.id != null && t.rankId != null) yearMap[t.id] = t.rankId;

        const slamCount    = Object.values(yearMap).filter(r => r === 4).length;
        const mastersCount = Object.values(yearMap).filter(r => r === 3).length;
        console.log(`  ${year}: ${cal.length} tournaments, ${Object.keys(yearMap).length} tiered (slams=${slamCount}, masters=${mastersCount})`);

        if (!Object.keys(yearMap).length) { skipped++; continue; }

        if (dryRun) continue;

        // Match cache.js's set() payload shape exactly: { data, cachedAt, stale }.
        const payload = JSON.stringify({ data: yearMap, cachedAt: new Date().toISOString(), stale: false });
        const filePath = join(tmpDir, `${year}.json`);
        writeFileSync(filePath, payload);

        const key = `tw:tier-map-v2:${tour}:${year}`;
        execFileSync('bunx', [
            'wrangler', 'kv:key', 'put', key,
            '--namespace-id', NAMESPACE_ID,
            '--path', filePath,
            '--ttl', String(TTL_TIERMAP),
        ], { cwd: repoDir, stdio: 'inherit' });
        written++;
        await sleep(150); // be polite to the Cloudflare API too
    }

    console.log(`\n${tour}: wrote ${written} year(s), skipped ${skipped} (empty).${dryRun ? ' (DRY RUN — nothing written)' : ''}`);
}

await main();
