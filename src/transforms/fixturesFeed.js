// RapidAPI fixtures (today / date / tournament) are not api-tennis rows.
// Livescore and hub unwrap `response.data` and read `id`, `player1.name`,
// `roundId`. The old transformFixtures mapper reads `event_key` /
// `event_date` / `tournament_name` and turns every RapidAPI row into blanks.
// This normalizer unwraps the same way, maps the RapidAPI fields, and drops
// any row that still has no matchKey.

import { ROUND_NAME } from './matchstatLive.js';
import { transformFixtures } from './index.js';

export function unwrapFixtureList(raw) {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.result)) return raw.result;
    return [];
}

function splitDateTime(value) {
    if (value == null || value === '') return { date: '', time: '', startsAtUtc: '' };
    const text = String(value).trim();
    const iso = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    const date = iso ? iso[1] : (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '');
    const time = iso ? iso[2] : '';
    return { date, time, startsAtUtc: toUtcTimestamp(text) };
}

// Full upstream instant, ISO 8601 with Z. A date-only value has no clock, so
// startsAtUtc stays empty rather than inventing midnight.
function toUtcTimestamp(text) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '';
    const zoned = /Z$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`;
    const ms = Date.parse(zoned);
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toISOString();
}

function roundLabel(row) {
    if (row?.roundId != null && ROUND_NAME[row.roundId]) return ROUND_NAME[row.roundId];
    if (row?.round?.name) return String(row.round.name);
    if (row?.roundId != null && row.roundId !== '') return `Round ${row.roundId}`;
    return '';
}

function isRapidFixture(row) {
    if (!row || typeof row !== 'object') return false;
    if (row.event_key != null && row.event_key !== '') return false;
    return row.id != null || row.matchId != null || row.player1 != null || row.player1Id != null;
}

function mapRapidFixture(row, fallback) {
    const id = row?.id ?? row?.matchId;
    const matchKey = id == null || id === '' ? '' : String(id);
    const when = splitDateTime(row?.date || row?.startTime || row?.timeGame);
    const tournamentKey = String(
        row?.tournament?.id ?? row?.tournamentId ?? fallback.tournamentKey ?? '',
    );
    const tournamentName = String(
        row?.tournament?.name ?? fallback.tournamentName ?? '',
    ).trim();
    const tour = fallback.tour || '';
    return {
        matchKey,
        tournamentKey,
        tournamentName,
        date: when.date,
        time: when.time,
        startsAtUtc: when.startsAtUtc,
        status: 'Not Started',
        round: roundLabel(row),
        season: when.date ? when.date.slice(0, 4) : '',
        eventType: tour ? `${tour} Singles` : '',
        player1Key: String(row?.player1Id ?? row?.player1?.id ?? ''),
        player1Name: row?.player1?.name || '',
        player1Logo: '',
        player2Key: String(row?.player2Id ?? row?.player2?.id ?? ''),
        player2Name: row?.player2?.name || '',
        player2Logo: '',
        finalResult: '',
        winner: '',
        isLive: false,
        setScores: [],
        currentGame: null,
        roundId: row?.roundId ?? null,
    };
}

/** @returns {object[]} rows that have a matchKey */
export function normalizeFixturesFeed(raw, fallback = {}) {
    const out = [];
    for (const row of unwrapFixtureList(raw)) {
        let mapped;
        if (isRapidFixture(row)) mapped = mapRapidFixture(row, fallback);
        else mapped = transformFixtures([row])[0];
        if (mapped?.matchKey) out.push(mapped);
    }
    return out;
}
