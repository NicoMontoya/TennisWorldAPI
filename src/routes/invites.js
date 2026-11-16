// ===================================
// TennisWorld — Invite codes
// ===================================
// POST /api/admin/invites          — mint a code, return the plaintext once
// POST /api/admin/invites/revoke   — { hash }
// POST /api/admin/invites/list     — hashes, uses, revoked, note (never codes)
//
// D1 table `invites` stores SHA-256(canonical code) as the primary key.
// KV is not used: a use is claimed with one conditional UPDATE so two
// concurrent redeems cannot both succeed. The account is created only when
// that statement changes exactly one row.
// The code itself is 160 bits from crypto.getRandomValues, shown as base32
// groups. A note is Nico's label. An email is never stored in it.

import { requireAdmin } from '../adminAuth.js';

export const INVITE_BYTES = 20; // 160 bits, above the 128-bit floor
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const INVITE_ERROR = "That invite didn't work. Check the code or ask Nico for a new one.";

const CLAIM_SQL = 'UPDATE invites SET uses = uses + 1 WHERE hash = ? AND revoked = 0 AND uses < max_uses';

function httpError(message, status) {
    return Object.assign(new Error(message), { status });
}

function db(env) {
    if (!env?.DB || typeof env.DB.prepare !== 'function') {
        throw httpError('Invite store unavailable', 500);
    }
    return env.DB;
}

export function encodeBase32(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

export function formatInviteCode(raw) {
    return raw.match(/.{1,4}/g).join('-');
}

// Dashes and whitespace are presentation only. Any other character fails
// closed so two different strings cannot collapse onto one hash.
export function canonicalInviteCode(raw) {
    if (typeof raw !== 'string') return '';
    const stripped = raw.trim().toUpperCase().replace(/[\s-]+/g, '');
    if (!stripped || stripped.length > 64 || !/^[A-Z2-7]+$/.test(stripped)) return '';
    return stripped;
}

export async function inviteKeyHash(canonical) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function mapInvite(row) {
    if (!row) return null;
    return {
        hash: row.hash,
        createdAt: row.created_at,
        maxUses: Number(row.max_uses),
        uses: Number(row.uses),
        revoked: Number(row.revoked) === 1,
        note: typeof row.note === 'string' ? row.note : '',
    };
}

export function inviteUsable(rec) {
    if (!rec || typeof rec !== 'object') return false;
    if (rec.revoked === true || rec.revoked === 1) return false;
    const uses = Number(rec.uses);
    const max = Number(rec.maxUses ?? rec.max_uses);
    if (!Number.isFinite(uses) || !Number.isFinite(max)) return false;
    return uses < max;
}

async function readInvite(env, hash) {
    const row = await db(env).prepare(
        'SELECT hash, created_at, max_uses, uses, revoked, note FROM invites WHERE hash = ?'
    ).bind(hash).first();
    return mapInvite(row);
}

export async function lookupInvite(env, rawCode) {
    const canonical = canonicalInviteCode(rawCode);
    if (!canonical) return null;
    const hash = await inviteKeyHash(canonical);
    const record = await readInvite(env, hash);
    if (!record) return null;
    return { hash, record };
}

// Atomic claim. True only when this statement changed exactly one row.
export async function consumeInvite(env, hash) {
    const result = await db(env).prepare(CLAIM_SQL).bind(hash).run();
    return Number(result?.meta?.changes) === 1;
}

function cleanNote(note) {
    if (note == null || note === '') return '';
    if (typeof note !== 'string') throw httpError('Note must be text', 400);
    const trimmed = note.trim();
    if (trimmed.length > 80) throw httpError('Note must be 80 characters or fewer', 400);
    // The note is Nico's label. Never store an email in it.
    if (trimmed.includes('@') || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(trimmed)) {
        throw httpError('Note cannot be an email', 400);
    }
    return trimmed;
}

function cleanMaxUses(raw) {
    if (raw == null || raw === '') return 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw httpError('maxUses must be an integer from 1 to 100', 400);
    }
    return n;
}

export async function issueInvite(env, { note, maxUses } = {}) {
    const bytes = new Uint8Array(INVITE_BYTES);
    crypto.getRandomValues(bytes);
    const compact = encodeBase32(bytes);
    const code = formatInviteCode(compact);
    const hash = await inviteKeyHash(compact);
    const rec = {
        createdAt: Date.now(),
        maxUses: cleanMaxUses(maxUses),
        uses: 0,
        note: cleanNote(note),
    };
    await db(env).prepare(
        'INSERT INTO invites (hash, created_at, max_uses, uses, revoked, note) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(hash, rec.createdAt, rec.maxUses, 0, 0, rec.note).run();
    return { code, hash, maxUses: rec.maxUses, note: rec.note };
}

async function readBody(request) {
    try {
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
        return body;
    } catch {
        return {};
    }
}

export async function handleCreateInvite(request, env) {
    requireAdmin(request, env);
    const body = await readBody(request);
    return issueInvite(env, { note: body.note, maxUses: body.maxUses });
}

export async function handleRevokeInvite(request, env) {
    requireAdmin(request, env);
    const body = await readBody(request);
    const hash = typeof body.hash === 'string' ? body.hash.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(hash)) throw httpError('hash is required', 400);
    const existing = await readInvite(env, hash);
    if (!existing) throw httpError('Invite not found', 404);
    await db(env).prepare('UPDATE invites SET revoked = 1 WHERE hash = ?').bind(hash).run();
    return { revoked: true, hash };
}

export async function handleListInvites(request, env) {
    requireAdmin(request, env);
    const listed = await db(env).prepare(
        'SELECT hash, created_at, max_uses, uses, revoked, note FROM invites ORDER BY created_at'
    ).all();
    const invites = (listed?.results || []).map(mapInvite).filter(Boolean);
    return { invites };
}
