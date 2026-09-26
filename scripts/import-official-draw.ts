// import-official-draw.ts
// Build one official first-round record from a saved draw sheet (text or PDF)
// plus our /api/draws payload, and POST it to /api/admin/import-official-draw.
//
// Dry-run by default. --commit performs the write (one KV put when the
// record changed, plus draws-cache deletes). This script does not fetch
// wtatennis.com / atptour.com / protennislive.com — pass a local text or PDF.
//
//   bun scripts/import-official-draw.ts \
//     --from-api \
//     --worker https://tennisworld-api.nicomontoya.workers.dev \
//     --official src/mocks/official/21352-hangzhou.txt \
//     --tour ATP --tournament-key 21352 --season 2026 \
//     --source-host atptour.com
//
//   # same command with --commit after the dry run looks right
//
// --draws path.json   use a saved /api/draws body instead of --from-api
// --checked-at YYYY-MM-DD   default: today (UTC)
// PDF input shells out to `pdftotext -layout`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argFlag, argValue, loadAdminSecret, resolveWorkerUrl } from './lib/backfill-cli.ts';
import {
    buildOfficialRecord,
    mapOfficialPairs,
    parseOfficialFirstRound,
    roundsFromDrawPayload,
} from '../src/officialDraw.js';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function die(msg: string, code = 1): never {
    console.error(msg);
    process.exit(code);
}

function readOfficial(path: string): string {
    if (/^https?:\/\//i.test(path)) {
        die('Refusing to fetch an external draw page. Pass a local .txt or .pdf. Worker-side fetch is a later change.');
    }
    if (path.toLowerCase().endsWith('.pdf')) {
        try {
            return execFileSync('pdftotext', ['-layout', path, '-'], {
                encoding: 'utf8',
                maxBuffer: 20_000_000,
            });
        } catch (err) {
            die(`pdftotext failed (${(err as Error).message}). Install poppler or pass a .txt extraction.`);
        }
    }
    return readFileSync(path, 'utf8');
}

async function loadDraw(worker: string): Promise<unknown> {
    const file = argValue(argv, '--draws');
    if (file) return JSON.parse(readFileSync(file, 'utf8'));
    if (!argFlag(argv, '--from-api')) die('Pass --draws path.json or --from-api.');
    const tour = (argValue(argv, '--tour') || '').toUpperCase();
    const tournamentKey = argValue(argv, '--tournament-key') || '';
    const season = argValue(argv, '--season') || '';
    const url = `${worker}/api/draws?tournamentKey=${encodeURIComponent(tournamentKey)}&season=${encodeURIComponent(season)}&tour=${encodeURIComponent(tour)}`;
    const res = await fetch(url);
    if (!res.ok) die(`GET ${url} → ${res.status}`);
    return res.json();
}

async function main() {
    const officialPath = argValue(argv, '--official');
    const tour = (argValue(argv, '--tour') || '').toUpperCase();
    const tournamentKey = argValue(argv, '--tournament-key') || '';
    const season = argValue(argv, '--season') || '';
    const sourceHost = argValue(argv, '--source-host') || '';
    const checkedAt = argValue(argv, '--checked-at') || new Date().toISOString().slice(0, 10);
    const commit = argFlag(argv, '--commit');
    if (!officialPath || !tour || !tournamentKey || !season || !sourceHost) {
        die('Required: --official --tour ATP|WTA --tournament-key ID --season YYYY --source-host HOST');
    }

    const parsed = parseOfficialFirstRound(readOfficial(officialPath));
    if (!parsed.ok) die(`Official sheet: ${parsed.error}`);

    const worker = resolveWorkerUrl(argv);
    const payload = await loadDraw(worker);
    const draw = roundsFromDrawPayload(payload);
    if (!draw) die('Draw payload has no rounds. Pass /api/draws JSON ({ok,data} or the data object).');

    const mapped = mapOfficialPairs(draw.rounds, parsed.pairs);
    if (!mapped.ok) {
        console.error('Unmapped official names (record rejected, draw stays unchecked):');
        for (const name of mapped.unmapped) console.error(`  - ${name}`);
        process.exit(1);
    }

    const built = buildOfficialRecord({
        tournamentKey,
        season,
        tour,
        sourceHost,
        checkedAt,
        slots: mapped.slots,
    });
    if (!built.ok) die(built.error);

    const record = built.record;
    console.log(JSON.stringify(record, null, 2));
    console.log(`slots ${record.slots.length}  checksum ${record.checksum}`);
    if (!commit) {
        console.log('Dry run. Nothing written. Re-run with --commit to POST the record.');
        return;
    }

    const secret = loadAdminSecret(repoDir);
    const res = await fetch(`${worker}/api/admin/import-official-draw`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-admin-secret': secret,
        },
        body: JSON.stringify(record),
    });
    const text = await res.text();
    if (!res.ok) die(`POST failed ${res.status}: ${text}`);
    console.log(text);
}

main().catch(err => die(err instanceof Error ? err.message : String(err)));
