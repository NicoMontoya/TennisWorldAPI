// ===================================
// TennisWorld — Official draw records
// ===================================
// One KV value per tournament edition (tournamentKey + season). The value is
// the printed first-round slot order as our player ids (or BYE), plus the
// source host, the day it was checked, and a checksum of that first round
// only. No seeds, scores, status, or later-round winners — those change all
// week and would burn writes.
//
// Checksum input, one line per slot: "{index}:{idA},{idB}" with the two ids
// sorted so the hash is the set of players in that slot. A side swap on the
// printed sheet does not stale the record; a withdrawal or lucky loser does.
//
// The public draw route reads this (a KV read, not a write). It lays the
// bracket out in this order only when the live first round is still the same
// set of players per slot AND played results sit inside those sections.
// Anything else stays on the winner-tree layout and is not "verified".

import { createHash } from 'node:crypto';

export const DRAWS_CACHE_RESOURCE = 'draws14';

export const ALLOWED_SOURCE_HOSTS = Object.freeze([
    'wtatennis.com',
    'wtafiles.wtatennis.com',
    'atptour.com',
    'protennislive.com',
]);

const SLOT_COUNT_MIN = 2;
const SLOT_COUNT_MAX = 64; // 128-draw first round

export function officialDrawKvKey(tour, tournamentKey, season) {
    return `tw:official-draw:v1:${String(tour).toUpperCase()}:${tournamentKey}:${season}`;
}

export function normalizeSourceHost(raw) {
    let host = String(raw ?? '').trim().toLowerCase();
    host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
}

export function canonSlotId(raw) {
    const s = String(raw ?? '').trim();
    if (/^bye$/i.test(s)) return 'BYE';
    if (/^\d{1,20}$/.test(s)) return s;
    return null;
}

/** SHA-256 of first-round structure only: slot index + player id or BYE. */
export function firstRoundChecksum(slots) {
    const lines = [];
    for (let i = 0; i < slots.length; i++) {
        const pair = slots[i];
        const a = canonSlotId(pair?.[0]);
        const b = canonSlotId(pair?.[1]);
        if (!a || !b) throw new Error('checksum requires a player id or BYE in every slot');
        lines.push(`${i}:${[a, b].sort().join(',')}`);
    }
    return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function fail(error) {
    return { ok: false, error };
}

export function validateOfficialRecord(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Record is required');
    for (const key of ['seeds', 'scores', 'winners', 'status']) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            return fail(`Record must not include ${key}`);
        }
    }

    const tour = String(body.tour || '').trim().toUpperCase();
    if (tour !== 'ATP' && tour !== 'WTA') return fail('tour must be ATP or WTA');

    const tournamentKey = String(body.tournamentKey ?? '').trim();
    if (!/^\d{1,20}$/.test(tournamentKey)) return fail('Invalid tournamentKey');

    const season = String(body.season ?? '').trim();
    if (!/^\d{4}$/.test(season)) return fail('season must be a 4-digit year');

    const sourceHost = normalizeSourceHost(body.sourceHost);
    if (!ALLOWED_SOURCE_HOSTS.includes(sourceHost)) return fail('sourceHost is not allowlisted');

    const checkedAt = String(body.checkedAt ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) return fail('checkedAt must be YYYY-MM-DD');

    if (!Array.isArray(body.slots)) return fail('slots must be an array');
    const n = body.slots.length;
    if (n < SLOT_COUNT_MIN || n > SLOT_COUNT_MAX || (n & (n - 1)) !== 0) {
        return fail('slots length must be a power of two from 2 to 64');
    }

    const seen = new Set();
    const slots = [];
    for (const pair of body.slots) {
        if (!Array.isArray(pair) || pair.length !== 2) {
            return fail('each slot must be [playerId or BYE, playerId or BYE]');
        }
        const top = canonSlotId(pair[0]);
        const bot = canonSlotId(pair[1]);
        if (!top || !bot) return fail('each slot side must be a player id or BYE');
        if (top === 'BYE' && bot === 'BYE') return fail('a slot cannot be two byes');
        if (top !== 'BYE' && top === bot) return fail('a slot cannot repeat a player');
        for (const id of [top, bot]) {
            if (id === 'BYE') continue;
            if (seen.has(id)) return fail('a player id appears in more than one slot');
            seen.add(id);
        }
        slots.push([top, bot]);
    }

    let checksum = '';
    try {
        checksum = firstRoundChecksum(slots);
    } catch {
        return fail('checksum requires a player id or BYE in every slot');
    }
    if (typeof body.checksum !== 'string' || body.checksum !== checksum) {
        return fail('checksum does not match the first-round slots');
    }

    return {
        ok: true,
        record: { tournamentKey, season, tour, sourceHost, checkedAt, slots, checksum },
    };
}

export function buildOfficialRecord(fields) {
    let checksum = '';
    try {
        checksum = firstRoundChecksum(fields?.slots || []);
    } catch (err) {
        return fail(err.message);
    }
    return validateOfficialRecord({ ...fields, checksum });
}

export async function readOfficialDraw(env, tour, tournamentKey, season) {
    if (!env?.TENNIS_CACHE?.get || !season || !tournamentKey || !tour) return null;
    try {
        const raw = await env.TENNIS_CACHE.get(
            officialDrawKvKey(tour, tournamentKey, season),
            'json',
        );
        return raw || null;
    } catch {
        return null;
    }
}

// ── Name mapping (script + tests; the Worker never fetches a draw sheet) ──

function foldName(s) {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Surname match on token boundaries. "Ce" does not match "Brace". */
export function surnameMatches(fullName, surname) {
    const full = foldName(fullName);
    const sur = foldName(surname);
    if (!sur) return false;
    if (sur === 'bye') return full === 'bye';
    return ` ${full} `.includes(` ${sur} `);
}

function extractPlayer(rest) {
    let s = String(rest || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 8; i++) {
        if (/^bye\b/i.test(s)) return { bye: true };
        // Entry codes only when they are not themselves the surname ("NG, …").
        const code = s.match(/^(WC|LL|NG|ALT|PR|SE|INV|JE|Q)\b(?!\s*,)\s*/i);
        if (code) { s = s.slice(code[0].length).trim(); continue; }
        const seed = s.match(/^\d{1,2}\s+(?=[A-Za-z])/);
        if (seed) { s = s.slice(seed[0].length).trim(); continue; }
        const name = s.match(/^([A-Za-z][A-Za-z'’.\- ]*[A-Za-z])\s*,/);
        if (name) {
            const surname = name[1].replace(/[.…]+$/g, '').replace(/\s+/g, ' ').trim();
            if (surname) return { surname };
        }
        return null;
    }
    return null;
}

/**
 * First-round pairs, top then bottom, from an official draw sheet's text
 * (pdftotext -layout output or a saved page). Stops at the first gap so the
 * seed list and later-round columns are not players.
 */
export function parseOfficialFirstRound(text) {
    const clean = String(text || '').replace(/\u00a0/g, ' ').replace(/\r/g, '');
    const players = [];
    let expect = 1;
    for (const line of clean.split('\n')) {
        const m = line.match(/^\s*(\d{1,3})\s+(\S.*)$/);
        if (!m) continue;
        const pos = Number(m[1]);
        if (pos !== expect || pos > 128) continue;
        const player = extractPlayer(m[2]);
        if (!player) return { ok: false, error: `Could not read official draw slot ${pos}` };
        players.push(player.bye ? 'Bye' : player.surname);
        expect++;
    }
    if (players.length < SLOT_COUNT_MIN || (players.length & (players.length - 1)) !== 0) {
        return { ok: false, error: `Official sheet parsed ${players.length} players, not a full first round` };
    }
    const pairs = [];
    for (let i = 0; i < players.length; i += 2) pairs.push([players[i], players[i + 1]]);
    return { ok: true, pairs };
}

function isRealPlayerKey(k) {
    return k != null && k !== '' && k !== 'null' && k !== 'undefined';
}

export function drawPlayers(rounds) {
    const byId = new Map();
    for (const round of rounds || []) {
        for (const m of round.matches || []) {
            for (const side of ['player1', 'player2']) {
                const name = m[`${side}Name`];
                const key = m[`${side}Key`];
                if (!name || /^bye$/i.test(String(name).trim()) || /^tbd$/i.test(String(name).trim())) continue;
                if (!isRealPlayerKey(key)) continue;
                const id = String(key);
                if (!byId.has(id)) byId.set(id, { id, name: String(name) });
            }
        }
    }
    return [...byId.values()];
}

/**
 * Map official surnames onto our player ids. Any miss or ambiguity rejects
 * the whole record — a failed match must not verify or flag the draw.
 */
export function mapOfficialPairs(rounds, pairs) {
    const players = drawPlayers(rounds);
    const used = new Set();
    const unmapped = [];
    const slots = [];
    for (const pair of pairs || []) {
        if (!Array.isArray(pair) || pair.length !== 2) {
            unmapped.push(String(pair));
            continue;
        }
        const slot = [];
        for (const label of pair) {
            if (foldName(label) === 'bye') {
                slot.push('BYE');
                continue;
            }
            const hits = players.filter(p => !used.has(p.id) && surnameMatches(p.name, label));
            if (hits.length !== 1) {
                unmapped.push(hits.length === 0 ? String(label) : `${label} (${hits.length} players)`);
                slot.push(null);
                continue;
            }
            used.add(hits[0].id);
            slot.push(hits[0].id);
        }
        slots.push(slot);
    }
    if (unmapped.length || slots.some(s => s.some(id => !id))) {
        return { ok: false, unmapped };
    }
    return { ok: true, slots };
}

export function roundsFromDrawPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (Array.isArray(payload.rounds)) return payload;
    if (payload.data && Array.isArray(payload.data.rounds)) return payload.data;
    return null;
}

// ── Live first round ↔ record ──────────────────────────────────────────────

export function slotSideId(match, side) {
    const name = match?.[`${side}Name`];
    if (typeof name === 'string' && /^bye$/i.test(name.trim())) return 'BYE';
    const key = match?.[`${side}Key`];
    if (isRealPlayerKey(key)) return String(key);
    return null;
}

function matchPlayerSet(match) {
    const a = slotSideId(match, 'player1');
    const b = slotSideId(match, 'player2');
    if (!a || !b) return null;
    return [a, b].sort().join(',');
}

/**
 * Pair each official slot with the live first-round match that has the same
 * player ids (order inside the slot does not matter). A missing match is
 * allowed only for a single printed bye whose player is not in any live
 * first-round match (unpublished bye). Any other difference is stale.
 */
export function planFirstRound(matches, slots) {
    const live = matches || [];
    const sets = live.map(matchPlayerSet);
    if (sets.some(s => s == null)) return { ok: false };
    const buckets = new Map();
    sets.forEach((set, i) => {
        if (!buckets.has(set)) buckets.set(set, []);
        buckets.get(set).push(i);
    });
    const used = new Set();
    const entries = [];
    for (const pair of slots) {
        const top = canonSlotId(pair?.[0]);
        const bot = canonSlotId(pair?.[1]);
        if (!top || !bot) return { ok: false };
        const set = [top, bot].sort().join(',');
        const hits = (buckets.get(set) || []).filter(i => !used.has(i));
        if (hits.length === 1) {
            used.add(hits[0]);
            entries.push({ matchIndex: hits[0], top, bot });
            continue;
        }
        if (hits.length > 1) return { ok: false };
        const real = [top, bot].filter(id => id !== 'BYE');
        if (real.length !== 1) return { ok: false };
        const appears = sets.some(s => s.split(',').includes(real[0]));
        if (appears) return { ok: false };
        entries.push({ matchIndex: -1, top, bot });
    }
    if (used.size !== live.length) return { ok: false };
    return { ok: true, entries };
}

/**
 * Played (or live) matches must fall inside the official section their two
 * players belong to. Unplayed fixtures are not proof — they are what the
 * winner-tree walk gets wrong when a half has not started.
 */
export function sectionConflict(rounds, firstRound, slots) {
    const slotOf = new Map();
    (slots || []).forEach((pair, i) => {
        for (const raw of pair) {
            const id = canonSlotId(raw);
            if (id && id !== 'BYE') slotOf.set(id, i);
        }
    });
    for (const round of rounds || []) {
        if (round === firstRound) continue;
        const depth = firstRound.order - round.order;
        if (!Number.isInteger(depth) || depth <= 0 || depth > 16) continue;
        const block = 2 ** depth;
        for (const match of round.matches || []) {
            if (!match?.winner && !match?.isLive) continue;
            const a = slotSideId(match, 'player1');
            const b = slotSideId(match, 'player2');
            if (!a || !b || a === 'BYE' || b === 'BYE') continue;
            if (!slotOf.has(a) || !slotOf.has(b)) continue;
            if (Math.floor(slotOf.get(a) / block) !== Math.floor(slotOf.get(b) / block)) return true;
        }
    }
    return false;
}
