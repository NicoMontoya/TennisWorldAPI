// D1 picks. The lock check is the upsert's WHERE, not a read followed by a write.

const COLUMNS = `member_id, match_key, picked_player_key, created_at, updated_at, locked_at, lock_at,
    result, rank_gap, player1_key, player2_key, scoreless_first_seen_at, scoreless_status_as_of, void_reason, tour`;

export const UPSERT_PICK_SQL = `INSERT INTO picks (${COLUMNS})
SELECT ?, ?, ?, ?, ?, NULL, ?, 'pending', NULL, '', '', NULL, '', ?
WHERE ? > ?
ON CONFLICT(member_id, match_key) DO UPDATE SET
    picked_player_key = excluded.picked_player_key,
    updated_at = CASE
        WHEN picks.picked_player_key = excluded.picked_player_key THEN picks.updated_at
        ELSE excluded.updated_at
    END,
    lock_at = excluded.lock_at,
    tour = excluded.tour
WHERE picks.locked_at IS NULL AND excluded.lock_at > ? AND picks.lock_at > ?`;

const LOCK_SQL = `UPDATE picks SET locked_at = ?, player1_key = ?, player2_key = ?, rank_gap = ?
WHERE member_id = ? AND match_key = ? AND locked_at IS NULL`;

const GRADE_SQL = `UPDATE picks SET result = ?, void_reason = ?, scoreless_first_seen_at = ?, scoreless_status_as_of = ?
WHERE member_id = ? AND match_key = ?
AND (result != ? OR void_reason != ? OR IFNULL(scoreless_first_seen_at, -1) != IFNULL(?, -1) OR scoreless_status_as_of != ?)`;

const SELECT_SQL = `SELECT ${COLUMNS} FROM picks`;

function db(env) {
    if (!env?.DB || typeof env.DB.prepare !== 'function') {
        throw Object.assign(new Error('Pick store unavailable'), { status: 500 });
    }
    return env.DB;
}

function changesOf(result) {
    const n = Number(result?.meta?.changes ?? result?.changes ?? 0);
    return Number.isFinite(n) ? n : 0;
}

export async function upsertPick(env, row, nowMs) {
    const result = await db(env).prepare(UPSERT_PICK_SQL).bind(
        row.memberId,
        row.matchKey,
        row.playerKey,
        row.createdAt,
        row.updatedAt,
        row.lockAt,
        row.tour,
        row.lockAt,
        nowMs,
        nowMs,
        nowMs,
    ).run();
    return changesOf(result);
}

export async function lockPick(env, row) {
    const result = await db(env).prepare(LOCK_SQL).bind(
        row.lockedAt,
        row.player1Key,
        row.player2Key,
        row.rankGap,
        row.memberId,
        row.matchKey,
    ).run();
    return changesOf(result);
}

export async function saveGrade(env, row) {
    const reason = row.voidReason || '';
    const firstSeen = row.firstSeenAt == null || row.firstSeenAt === '' ? null : Number(row.firstSeenAt);
    const asOf = row.statusAsOf || '';
    const result = await db(env).prepare(GRADE_SQL).bind(
        row.result,
        reason,
        firstSeen,
        asOf,
        row.memberId,
        row.matchKey,
        row.result,
        reason,
        firstSeen,
        asOf,
    ).run();
    return changesOf(result);
}

export async function listPicks(env, memberId) {
    const sql = memberId ? `${SELECT_SQL} WHERE member_id = ?` : SELECT_SQL;
    const stmt = db(env).prepare(sql);
    const bound = memberId ? stmt.bind(memberId) : stmt;
    const listed = await bound.all();
    return listed?.results || [];
}

export async function readPick(env, memberId, matchKey) {
    const row = await db(env).prepare(`${SELECT_SQL} WHERE member_id = ? AND match_key = ?`)
        .bind(memberId, matchKey)
        .first();
    return row || null;
}
