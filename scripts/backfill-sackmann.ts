// backfill-sackmann.ts
// Backfills KV ranking history from Jeff Sackmann's open tennis datasets.
//
// Sources:
//   ATP: https://github.com/JeffSackmann/tennis_atp
//   WTA: https://github.com/JeffSackmann/tennis_wta
//
// Run with wrangler dev active:
//   bun run scripts/backfill-sackmann.ts

const WORKER_URL   = 'http://127.0.0.1:8787';
const ADMIN_SECRET = 'change-me-before-deploy';
const WEEKS_BACK   = 52; // how far back to import (max 104 = 2 years)

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(d: string): string {
    // YYYYMMDD → YYYY-MM-DD
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function cutoffDate(): string {
    const d = new Date();
    d.setDate(d.getDate() - WEEKS_BACK * 7);
    return d.toISOString().split('T')[0];
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.text();
}

function parseCSV(text: string): { header: string[]; rows: string[][] } {
    const lines = text.trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim());
    const rows   = lines.slice(1).map(l => l.split(','));
    return { header, rows };
}

function col(header: string[], row: string[], name: string): string {
    return row[header.indexOf(name)]?.trim() ?? '';
}

// ── Per-tour backfill ──────────────────────────────────────────────────────────

async function backfill(tour: 'ATP' | 'WTA') {
    const slug = tour.toLowerCase();
    const repo = tour === 'ATP' ? 'tennis_atp' : 'tennis_wta';
    const base = `https://raw.githubusercontent.com/JeffSackmann/${repo}/master`;

    console.log(`\n── ${tour} ─────────────────────────────────`);

    // 1. Sackmann player list → id → "First Last"
    console.log('  Fetching Sackmann player list...');
    const { header: ph, rows: pr } = parseCSV(await fetchText(`${base}/${slug}_players.csv`));
    const sackmannName = new Map<string, string>();
    for (const row of pr) {
        const id   = col(ph, row, 'player_id');
        const name = `${col(ph, row, 'name_first')} ${col(ph, row, 'name_last')}`;
        if (id) sackmannName.set(id, name);
    }
    console.log(`  Loaded ${sackmannName.size} Sackmann players`);

    // 2. Our standings → "name" → playerKey (RapidAPI)
    console.log('  Fetching current standings from Worker...');
    const standRes = await fetch(`${WORKER_URL}/api/standings?tour=${tour}`);
    const stand    = await standRes.json() as { ok: boolean; data: Array<{ playerKey: string; name: string }> };
    const nameToKey = new Map<string, string>();
    for (const p of (stand.data ?? [])) {
        nameToKey.set(p.name.toLowerCase(), p.playerKey);
    }
    console.log(`  Loaded ${nameToKey.size} players from standings`);

    // 3. Build Sackmann id → RapidAPI playerKey via name
    const sackToRapid = new Map<string, string>();
    let matched = 0, unmatched: string[] = [];
    for (const [sid, name] of sackmannName) {
        const key = nameToKey.get(name.toLowerCase());
        if (key) { sackToRapid.set(sid, key); matched++; }
        else unmatched.push(name);
    }
    console.log(`  Name-matched: ${matched} / ${sackmannName.size}`);

    // Show any currently-ranked players we couldn't match (may be name variations)
    const unmatchedRanked = unmatched.filter(n => nameToKey.has(n.toLowerCase()));
    if (unmatchedRanked.length) console.log('  Unmatched ranked players:', unmatchedRanked);

    // 4. Load ranking CSVs and collect history for matched players
    const cutoff = cutoffDate();
    console.log(`  Cutoff date: ${cutoff} (${WEEKS_BACK} weeks back)`);

    const histories: Record<string, Array<{ date: string; rank: number }>> = {};
    let totalRows = 0, usedRows = 0;

    for (const file of [`${slug}_rankings_20s.csv`, `${slug}_rankings_current.csv`]) {
        console.log(`  Processing ${file}...`);
        const { header: rh, rows } = parseCSV(await fetchText(`${base}/${file}`));

        for (const row of rows) {
            totalRows++;
            const rawDate = col(rh, row, 'ranking_date');
            if (!rawDate || rawDate.length < 8) continue;

            const date = fmtDate(rawDate);
            if (date < cutoff) continue;

            const sid      = col(rh, row, 'player');
            const rapidKey = sackToRapid.get(sid);
            if (!rapidKey) continue;

            const rank = parseInt(col(rh, row, 'rank'));
            if (isNaN(rank) || rank <= 0) continue;

            if (!histories[rapidKey]) histories[rapidKey] = [];
            histories[rapidKey].push({ date, rank });
            usedRows++;
        }
    }

    const playerCount = Object.keys(histories).length;
    console.log(`  CSV rows scanned: ${totalRows.toLocaleString()}, used: ${usedRows.toLocaleString()}`);
    console.log(`  Players with history: ${playerCount}`);

    if (playerCount === 0) {
        console.log('  ⚠ No matched players found — check name mapping');
        return;
    }

    // 5. Deduplicate entries per player (keep most recent rank per date)
    for (const key of Object.keys(histories)) {
        const byDate = new Map<string, number>();
        for (const { date, rank } of histories[key]) {
            if (!byDate.has(date) || rank < byDate.get(date)!) byDate.set(date, rank);
        }
        histories[key] = Array.from(byDate.entries())
            .map(([date, rank]) => ({ date, rank }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    // 6. POST to Worker import endpoint
    console.log(`  Posting to Worker...`);
    const importRes = await fetch(`${WORKER_URL}/api/admin/import-rank-history`, {
        method:  'POST',
        headers: {
            'Content-Type':    'application/json',
            'x-admin-secret':  ADMIN_SECRET,
        },
        body: JSON.stringify({ tour, histories }),
    });

    const result = await importRes.json() as { ok: boolean; data: { written: number; errors: number } };
    const d = result.data ?? (result as any);
    console.log(`  ✓ Written: ${d.written}, Errors: ${d.errors}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

await backfill('ATP');
await backfill('WTA');
console.log('\nDone.');
