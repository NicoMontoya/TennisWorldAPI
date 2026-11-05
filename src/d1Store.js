// D1 last-good rows for calendar, draws, fixtures, and standings.
// Missing binding, a failed statement, or an exhausted daily budget never
// throws to the client — the route still returns the live payload or the
// previously stored copy. Statements run in capped batches.

export const DEFAULT_D1_DAILY_WRITE_BUDGET = 20000;
export const DEFAULT_D1_BACKFILL_BATCH = 40;
const HARD_BATCH_CEILING = 200;
const STATEMENT_BATCH = 40;

const INSERT = {
    tournaments: `INSERT INTO tournaments (tour, tournament_key, payload, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tour, tournament_key) DO UPDATE SET
            payload = excluded.payload,
            fetched_at = excluded.fetched_at`,
    draws: `INSERT INTO draws (tour, tournament_key, payload, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tour, tournament_key) DO UPDATE SET
            payload = excluded.payload,
            fetched_at = excluded.fetched_at`,
    fixtures: `INSERT INTO fixtures (tour, match_key, tournament_key, match_date, payload, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tour, match_key) DO UPDATE SET
            tournament_key = excluded.tournament_key,
            match_date = excluded.match_date,
            payload = excluded.payload,
            fetched_at = excluded.fetched_at`,
    standings: `INSERT INTO standings (tour, player_key, payload, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tour, player_key) DO UPDATE SET
            payload = excluded.payload,
            fetched_at = excluded.fetched_at`,
    api_tennis_lists: `INSERT INTO api_tennis_lists (resource, tour, natural_key, payload, fetched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(resource, tour, natural_key) DO UPDATE SET
            payload = excluded.payload,
            fetched_at = excluded.fetched_at`,
};

const INSERT_BINDS = {
    tournaments: row => [row.tour, row.tournament_key, row.payload, row.fetched_at],
    draws: row => [row.tour, row.tournament_key, row.payload, row.fetched_at],
    fixtures: row => [row.tour, row.match_key, row.tournament_key, row.match_date, row.payload, row.fetched_at],
    standings: row => [row.tour, row.player_key, row.payload, row.fetched_at],
    api_tennis_lists: row => [row.resource, row.tour, row.natural_key, row.payload, row.fetched_at],
};

export function d1DailyWriteBudget(env) {
    const raw = env?.D1_DAILY_WRITE_BUDGET;
    if (raw == null || String(raw).trim() === '') return DEFAULT_D1_DAILY_WRITE_BUDGET;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_D1_DAILY_WRITE_BUDGET;
    return Math.floor(n);
}

export function d1BackfillBatch(env) {
    const raw = env?.D1_BACKFILL_BATCH;
    if (raw == null || String(raw).trim() === '') return DEFAULT_D1_BACKFILL_BATCH;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_D1_BACKFILL_BATCH;
    return Math.min(HARD_BATCH_CEILING, Math.floor(n));
}

function utcDay(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

function hasDb(env) {
    return !!(env && env.DB && typeof env.DB.prepare === 'function');
}

/** Writes still allowed today. 0 when the binding is missing or the read fails. */
export async function d1WritesRemaining(env, now = new Date()) {
    if (!hasDb(env)) return 0;
    const budget = d1DailyWriteBudget(env);
    if (budget <= 0) return 0;
    try {
        const row = await env.DB.prepare(
            `SELECT writes FROM d1_write_ledger WHERE day = ?`,
        ).bind(utcDay(now)).first();
        const used = Number(row?.writes || 0);
        if (!Number.isFinite(used) || used < 0) return budget;
        return Math.max(0, budget - used);
    } catch {
        return 0;
    }
}

/**
 * Reserve up to `want` row-writes for today. Returns how many were granted.
 * `allOrNothing` grants `want` only when the whole set fits, and does not
 * consume budget when it does not.
 */
export async function reserveD1Writes(env, want, { allOrNothing = false, now = new Date() } = {}) {
    const n = Math.max(0, Math.floor(Number(want) || 0));
    if (!n || !hasDb(env)) return 0;
    const budget = d1DailyWriteBudget(env);
    if (budget <= 0) return 0;
    const day = utcDay(now);
    try {
        await env.DB.prepare(
            `INSERT INTO d1_write_ledger (day, writes) VALUES (?, 0)
             ON CONFLICT(day) DO NOTHING`,
        ).bind(day).run();
        const row = await env.DB.prepare(
            `SELECT writes FROM d1_write_ledger WHERE day = ?`,
        ).bind(day).first();
        const used = Number(row?.writes || 0);
        const room = Math.max(0, budget - (Number.isFinite(used) ? used : 0));
        const grant = allOrNothing ? (room >= n ? n : 0) : Math.min(n, room);
        if (grant <= 0) return 0;
        const updated = await env.DB.prepare(
            `UPDATE d1_write_ledger
             SET writes = writes + ?
             WHERE day = ? AND writes + ? <= ?`,
        ).bind(grant, day, grant, budget).run();
        const changes = Number(updated?.meta?.changes ?? updated?.changes ?? 0);
        return changes > 0 ? grant : 0;
    } catch {
        console.warn('[d1] write budget check failed');
        return 0;
    }
}

async function runStatements(env, statements) {
    for (let i = 0; i < statements.length; i += STATEMENT_BATCH) {
        const chunk = statements.slice(i, i + STATEMENT_BATCH);
        if (typeof env.DB.batch === 'function') {
            await env.DB.batch(chunk);
        } else {
            for (const stmt of chunk) await stmt.run();
        }
    }
}

async function writeRows(env, table, rows, { replace = false, tour, fetchedAt } = {}) {
    if (!hasDb(env) || !rows.length) return { written: 0 };
    // A full replace that does not fit is skipped entirely so a partial
    // standings or calendar pull cannot delete the previous complete set.
    const grant = await reserveD1Writes(env, rows.length, { allOrNothing: replace });
    if (grant <= 0) return { written: 0, budget: true };
    const slice = rows.slice(0, grant);
    try {
        const sql = INSERT[table];
        const bind = INSERT_BINDS[table];
        const statements = slice.map(row => env.DB.prepare(sql).bind(...bind(row)));
        await runStatements(env, statements);
        if (replace && tour && fetchedAt && (table === 'tournaments' || table === 'standings')) {
            await env.DB.prepare(
                `DELETE FROM ${table} WHERE tour = ? AND fetched_at < ?`,
            ).bind(tour, fetchedAt).run();
        }
        return { written: slice.length, budget: grant < rows.length };
    } catch {
        console.warn('[d1] write failed');
        return { written: 0 };
    }
}

function parsePayload(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
}

async function selectAll(env, sql, ...binds) {
    if (!hasDb(env)) return null;
    try {
        const res = await env.DB.prepare(sql).bind(...binds).all();
        const results = res?.results;
        return Array.isArray(results) ? results : [];
    } catch {
        console.warn('[d1] read failed');
        return null;
    }
}

function maxFetched(results) {
    let best = '';
    for (const row of results) {
        const at = row?.fetched_at || '';
        if (at > best) best = at;
    }
    return best;
}

export async function rememberTournaments(env, tour, rawItems, { replace = false } = {}) {
    const fetchedAt = new Date().toISOString();
    const rows = [];
    for (const item of rawItems || []) {
        if (item?.id == null || item.id === '') continue;
        rows.push({
            tour,
            tournament_key: String(item.id),
            payload: JSON.stringify(item),
            fetched_at: fetchedAt,
        });
    }
    if (!rows.length) return { written: 0 };
    return writeRows(env, 'tournaments', rows, { replace, tour, fetchedAt });
}

export async function readTournaments(env, tour) {
    const results = await selectAll(
        env,
        `SELECT payload, fetched_at FROM tournaments WHERE tour = ?`,
        tour,
    );
    if (!results) return null;
    if (!results.length) return null;
    const rows = [];
    for (const row of results) {
        const payload = parsePayload(row.payload);
        if (payload && typeof payload === 'object') rows.push(payload);
    }
    return { rows, asOf: maxFetched(results), hadRows: true };
}

export async function rememberDraw(env, tour, tournamentKey, payload) {
    if (!payload || tournamentKey == null || tournamentKey === '') return { written: 0 };
    const fetchedAt = new Date().toISOString();
    return writeRows(env, 'draws', [{
        tour,
        tournament_key: String(tournamentKey),
        payload: JSON.stringify(payload),
        fetched_at: fetchedAt,
    }], { replace: false, tour, fetchedAt });
}

export async function readDraw(env, tour, tournamentKey) {
    const results = await selectAll(
        env,
        `SELECT payload, fetched_at FROM draws WHERE tour = ? AND tournament_key = ?`,
        tour,
        String(tournamentKey),
    );
    if (!results?.length) return null;
    const payload = parsePayload(results[0].payload);
    if (!payload || typeof payload !== 'object') return null;
    return { payload, asOf: results[0].fetched_at || maxFetched(results) };
}

export async function rememberFixtures(env, tour, fixtures) {
    const fetchedAt = new Date().toISOString();
    const rows = [];
    for (const fixture of fixtures || []) {
        if (!fixture?.matchKey) continue;
        rows.push({
            tour,
            match_key: String(fixture.matchKey),
            tournament_key: String(fixture.tournamentKey || ''),
            match_date: String(fixture.date || ''),
            payload: JSON.stringify(fixture),
            fetched_at: fetchedAt,
        });
    }
    if (!rows.length) return { written: 0 };
    return writeRows(env, 'fixtures', rows, { replace: false, tour, fetchedAt });
}

export async function readFixtures(env, { tour, tournamentKey, dateStart, dateStop, upcomingFrom } = {}) {
    const results = await selectAll(
        env,
        `SELECT payload, fetched_at, tournament_key, match_date FROM fixtures WHERE tour = ?`,
        tour,
    );
    if (!results) return null;
    if (!results.length) return null;
    const asOf = maxFetched(results);
    let rows = [];
    for (const row of results) {
        const payload = parsePayload(row.payload);
        if (!payload?.matchKey) continue;
        const tkey = String(row.tournament_key || payload.tournamentKey || '');
        const date = String(row.match_date || payload.date || '');
        if (tournamentKey && tkey !== String(tournamentKey)) continue;
        if (dateStart && date && date < dateStart) continue;
        if (dateStop && date && date > dateStop) continue;
        if (upcomingFrom && date && date < upcomingFrom) continue;
        rows.push(payload);
    }
    return { rows, asOf, hadRows: true };
}

export async function rememberStandings(env, tour, standings, { replace = false } = {}) {
    const fetchedAt = new Date().toISOString();
    const rows = [];
    for (const row of standings || []) {
        if (!row?.playerKey) continue;
        rows.push({
            tour,
            player_key: String(row.playerKey),
            payload: JSON.stringify(row),
            fetched_at: fetchedAt,
        });
    }
    if (!rows.length) return { written: 0 };
    return writeRows(env, 'standings', rows, { replace, tour, fetchedAt });
}

export async function readStandings(env, tour) {
    const results = await selectAll(
        env,
        `SELECT payload, fetched_at FROM standings WHERE tour = ?`,
        tour,
    );
    if (!results) return null;
    if (!results.length) return null;
    const rows = [];
    for (const row of results) {
        const payload = parsePayload(row.payload);
        if (payload?.playerKey) rows.push(payload);
    }
    rows.sort((a, b) => (a.rank || 0) - (b.rank || 0));
    return { rows, asOf: maxFetched(results), hadRows: true };
}

export async function rememberApiTennisList(env, resource, tour, rows) {
    const fetchedAt = new Date().toISOString();
    const stored = [];
    for (const row of rows || []) {
        const key = row?.tournamentKey || row?.playerKey || row?.matchKey;
        if (!key) continue;
        stored.push({
            resource,
            tour,
            natural_key: String(key),
            payload: JSON.stringify(row),
            fetched_at: fetchedAt,
        });
    }
    if (!stored.length) return { written: 0 };
    return writeRows(env, 'api_tennis_lists', stored, { replace: false, tour, fetchedAt });
}

export async function readApiTennisList(env, resource, tour) {
    const results = await selectAll(
        env,
        `SELECT payload, fetched_at FROM api_tennis_lists WHERE resource = ? AND tour = ?`,
        resource,
        tour,
    );
    if (!results?.length) return null;
    const rows = [];
    for (const row of results) {
        const payload = parsePayload(row.payload);
        if (payload && typeof payload === 'object') rows.push(payload);
    }
    return { rows, asOf: maxFetched(results), hadRows: true };
}
