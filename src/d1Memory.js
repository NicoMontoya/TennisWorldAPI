// In-memory D1 double for tests. Understands the statements d1Store.js sends.

const TABLES = ['tournaments', 'draws', 'fixtures', 'standings', 'd1_write_ledger', 'api_tennis_lists', 'call_tally', 'invites', 'picks'];
const PK = {
    tournaments: ['tour', 'tournament_key'],
    draws: ['tour', 'tournament_key'],
    fixtures: ['tour', 'match_key'],
    standings: ['tour', 'player_key'],
    d1_write_ledger: ['day'],
    api_tennis_lists: ['resource', 'tour', 'natural_key'],
    call_tally: ['provider', 'utc_day'],
    invites: ['hash'],
    picks: ['member_id', 'match_key'],
};

function claimCallTally(tables, args) {
    const [provider, day, capInsert, capUpdate] = args;
    const cap = Number(capUpdate);
    let row = tables.call_tally.find(item => item.provider === provider && item.utc_day === day);
    if (!row) {
        if (!(Number(capInsert) > 0)) return [];
        row = { provider, utc_day: day, count: 1 };
        tables.call_tally.push(row);
        return [{ count: 1 }];
    }
    if (row.count < cap) {
        row.count += 1;
        return [{ count: row.count }];
    }
    return [];
}

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

    function findPick(memberId, matchKey) {
        return tables.picks.find(row => row.member_id === memberId && row.match_key === matchKey);
    }

    function exec(sql, args) {
        // Mirrors the picks upsert: the lock predicate is in the statement.
        // A locked row, or a lock_at that is not still ahead of now, is unchanged.
        if (sql.startsWith('INSERT INTO picks')) {
            const [
                memberId, matchKey, playerKey, createdAt, updatedAt, lockAt, tour,
                lockAtWhere, nowInsert, nowUpdate, nowStored,
            ] = args;
            const existing = findPick(memberId, matchKey);
            const stillOpen = Number(lockAtWhere) > Number(nowInsert);
            if (!existing) {
                if (!stillOpen) return { meta: { changes: 0 } };
                tables.picks.push({
                    member_id: memberId,
                    match_key: matchKey,
                    picked_player_key: playerKey,
                    created_at: createdAt,
                    updated_at: updatedAt,
                    locked_at: null,
                    lock_at: lockAt,
                    result: 'pending',
                    rank_gap: null,
                    player1_key: '',
                    player2_key: '',
                    scoreless_seen: 0,
                    void_reason: '',
                    tour,
                });
                return { meta: { changes: 1 } };
            }
            if (existing.locked_at != null) return { meta: { changes: 0 } };
            if (!(Number(lockAt) > Number(nowUpdate))) return { meta: { changes: 0 } };
            if (!(Number(existing.lock_at) > Number(nowStored))) return { meta: { changes: 0 } };
            if (existing.picked_player_key !== playerKey) existing.updated_at = updatedAt;
            existing.picked_player_key = playerKey;
            existing.lock_at = lockAt;
            existing.tour = tour;
            return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE picks SET locked_at')) {
            const [lockedAt, p1, p2, rankGap, memberId, matchKey] = args;
            const row = findPick(memberId, matchKey);
            if (!row || row.locked_at != null) return { meta: { changes: 0 } };
            row.locked_at = lockedAt;
            row.player1_key = p1;
            row.player2_key = p2;
            row.rank_gap = rankGap;
            return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE picks SET result')) {
            const [result, seen, reason, memberId, matchKey, result2, seen2, reason2] = args;
            const row = findPick(memberId, matchKey);
            if (!row) return { meta: { changes: 0 } };
            if (row.result === result2 && Number(row.scoreless_seen) === Number(seen2) && row.void_reason === reason2) {
                return { meta: { changes: 0 } };
            }
            row.result = result;
            row.scoreless_seen = seen;
            row.void_reason = reason;
            return { meta: { changes: 1 } };
        }
        // One statement, no await. Concurrent claims of the same invite cannot
        // both observe uses < max_uses.
        if (sql.startsWith('UPDATE invites SET uses = uses + 1')) {
            const row = tables.invites.find(item => item.hash === args[0]);
            if (!row || Number(row.revoked) !== 0 || !(Number(row.uses) < Number(row.max_uses))) {
                return { success: true, meta: { changes: 0 } };
            }
            row.uses = Number(row.uses) + 1;
            return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE invites SET revoked = 1')) {
            const row = tables.invites.find(item => item.hash === args[0]);
            if (!row) return { success: true, meta: { changes: 0 } };
            row.revoked = 1;
            return { success: true, meta: { changes: 1 } };
        }
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
        if (sql.includes('FROM picks')) {
            let rows = tables.picks;
            if (sql.includes('member_id = ?') && sql.includes('match_key = ?')) {
                rows = rows.filter(row => row.member_id === args[0] && row.match_key === args[1]);
            } else if (sql.includes('member_id = ?')) {
                rows = rows.filter(row => row.member_id === args[0]);
            }
            return rows.map(row => ({ ...row }));
        }
        if (sql.includes('FROM invites')) {
            let rows = tables.invites;
            if (sql.includes('WHERE hash = ?')) {
                rows = rows.filter(row => row.hash === args[0]);
            }
            return rows
                .map(row => ({ ...row }))
                .sort((a, b) => Number(a.created_at) - Number(b.created_at));
        }
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
                if (text.includes('INSERT INTO call_tally')) {
                    return { results: claimCallTally(tables, args) };
                }
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
