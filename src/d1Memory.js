// In-memory D1 double for tests. Understands the statements d1Store.js sends.

const TABLES = ['tournaments', 'draws', 'fixtures', 'standings', 'd1_write_ledger', 'api_tennis_lists'];
const PK = {
    tournaments: ['tour', 'tournament_key'],
    draws: ['tour', 'tournament_key'],
    fixtures: ['tour', 'match_key'],
    standings: ['tour', 'player_key'],
    d1_write_ledger: ['day'],
    api_tennis_lists: ['resource', 'tour', 'natural_key'],
};

function normalize(sql) {
    return String(sql).replace(/\s+/g, ' ').trim();
}

function pkKey(table, row) {
    return PK[table].map(col => row[col]).join('\0');
}

export function createMemoryD1() {
    const tables = Object.fromEntries(TABLES.map(name => [name, []]));

    function upsert(table, row) {
        const list = tables[table];
        const key = pkKey(table, row);
        const idx = list.findIndex(existing => pkKey(table, existing) === key);
        if (idx >= 0) list[idx] = { ...list[idx], ...row };
        else list.push({ ...row });
    }

    function exec(sql, args) {
        if (sql.startsWith('INSERT INTO d1_write_ledger')) {
            const day = args[0];
            if (!tables.d1_write_ledger.some(row => row.day === day)) {
                tables.d1_write_ledger.push({ day, writes: 0 });
                return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
        }
        if (sql.startsWith('UPDATE d1_write_ledger')) {
            const [grant, day, , budget] = args;
            const row = tables.d1_write_ledger.find(item => item.day === day);
            if (!row || row.writes + grant > budget) return { meta: { changes: 0 } };
            row.writes += grant;
            return { meta: { changes: 1 } };
        }
        const del = sql.match(/^DELETE FROM (\w+) WHERE tour = \? AND fetched_at < \?/i);
        if (del) {
            const table = del[1];
            const [tour, fetchedAt] = args;
            const before = tables[table].length;
            tables[table] = tables[table].filter(row => !(row.tour === tour && row.fetched_at < fetchedAt));
            return { meta: { changes: before - tables[table].length } };
        }
        const insert = sql.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES/i);
        if (insert) {
            const table = insert[1];
            const cols = insert[2].split(',').map(col => col.trim());
            const row = {};
            cols.forEach((col, i) => { row[col] = args[i]; });
            upsert(table, row);
            return { meta: { changes: 1 } };
        }
        throw new Error(`unsupported sql: ${sql}`);
    }

    function query(sql, args) {
        if (sql.startsWith('SELECT writes FROM d1_write_ledger')) {
            const row = tables.d1_write_ledger.find(item => item.day === args[0]);
            return row ? [{ writes: row.writes }] : [];
        }
        if (sql.startsWith('SELECT') && sql.includes('FROM api_tennis_lists')) {
            return tables.api_tennis_lists
                .filter(row => row.resource === args[0] && row.tour === args[1])
                .map(row => ({ ...row }));
        }
        const sel = sql.match(/^SELECT (.+) FROM (\w+) WHERE tour = \?( AND tournament_key = \?)?/i);
        if (!sel) throw new Error(`unsupported select: ${sql}`);
        const table = sel[2];
        let rows = tables[table].filter(row => row.tour === args[0]);
        if (sel[3]) rows = rows.filter(row => row.tournament_key === args[1]);
        return rows.map(row => ({ ...row }));
    }

    function prepare(sql) {
        const text = normalize(sql);
        let args = [];
        const stmt = {
            bind(...bound) {
                args = bound;
                return stmt;
            },
            async run() {
                return exec(text, args);
            },
            async all() {
                return { results: query(text, args) };
            },
            async first() {
                return query(text, args)[0] || null;
            },
        };
        return stmt;
    }

    return {
        prepare,
        async batch(stmts) {
            const out = [];
            for (const stmt of stmts) out.push(await stmt.run());
            return out;
        },
        _tables: tables,
    };
}
