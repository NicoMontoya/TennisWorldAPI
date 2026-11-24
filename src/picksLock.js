// Lock instant for a tour singles match. The client clock is never an input.
// Status that has left Not Started locks immediately. A startsAtUtc and an
// order-of-play slot lock at the earlier of those two. Day start (the earlier
// of venue midnight and UTC midnight) is only the fallback when neither
// exists, so it cannot pull a timed match earlier. No date and no clock:
// not pickable.

const LOCKING = new Set(['Live', 'Delayed', 'Finished', 'Walkover', 'Cancelled']);

export function statusLocks(status) {
    return LOCKING.has(status);
}

function validZone(zone) {
    if (!zone || zone.length > 64) return '';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
        return zone;
    } catch {
        return '';
    }
}

export function timeZoneOf(row) {
    const explicit = validZone(String(row?.timeZone || row?.timezone || row?.tournamentTimeZone || '').trim());
    if (explicit) return explicit;
    const place = `${row?.venue || ''} ${row?.city || ''} ${row?.tournamentCity || ''} ${row?.tournamentName || ''}`;
    // 2026 ATP Finals are in Turin. A feed that names the event but not a
    // zone still locks on Europe/Rome, which is earlier than UTC in November.
    if (/\bturin\b|\btorino\b|\batp finals\b|\bnitto\b/i.test(place)) return 'Europe/Rome';
    return '';
}

function zoneOffsetMs(utcMs, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    const map = {};
    for (const part of fmt.formatToParts(new Date(utcMs))) {
        if (part.type !== 'literal') map[part.type] = part.value;
    }
    let hour = Number(map.hour);
    let day = Number(map.day);
    let month = Number(map.month);
    let year = Number(map.year);
    if (hour === 24) {
        hour = 0;
        const rolled = new Date(Date.UTC(year, month - 1, day + 1));
        year = rolled.getUTCFullYear();
        month = rolled.getUTCMonth() + 1;
        day = rolled.getUTCDate();
    }
    const asUtc = Date.UTC(year, month - 1, day, hour, Number(map.minute), Number(map.second));
    return asUtc - utcMs;
}

/** UTC ms of a civil YYYY-MM-DD HH:MM in an IANA zone. */
export function zonedDateTimeToUtc(date, hhmm, timeZone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return NaN;
    if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return NaN;
    if (!timeZoneOf({ timeZone })) return NaN;
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    let utc = Date.UTC(y, m - 1, d, hh, mm, 0);
    for (let i = 0; i < 2; i++) utc = Date.UTC(y, m - 1, d, hh, mm, 0) - zoneOffsetMs(utc, timeZone);
    return utc;
}

/**
 * Start of the match date. Venue midnight when the zone is known, otherwise
 * UTC midnight, and the earlier of the two when both exist.
 */
export function earlierDayStartUtc(date, timeZone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return NaN;
    const utcStart = Date.parse(`${date}T00:00:00.000Z`);
    const zone = validZone(timeZone);
    if (!zone) return utcStart;
    const localStart = zonedDateTimeToUtc(date, '00:00', zone);
    if (!Number.isFinite(localStart)) return utcStart;
    return Math.min(utcStart, localStart);
}

function slotClock(row) {
    for (const raw of [row?.orderOfPlay, row?.notBefore]) {
        if (typeof raw !== 'string') continue;
        const text = raw.trim();
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
            const ms = Date.parse(text);
            if (Number.isFinite(ms)) return ms;
        }
        if (/^\d{2}:\d{2}$/.test(text)) return text;
    }
    if (!row?.startsAtUtc && /^\d{2}:\d{2}$/.test(row?.time || '')) return row.time;
    return null;
}

/** Order-of-play instant, or null when it cannot be placed on the timeline. */
export function orderOfPlayUtc(row) {
    const slot = slotClock(row);
    if (typeof slot === 'number') return slot;
    if (typeof slot !== 'string') return null;
    const zone = timeZoneOf(row);
    if (!zone || !row?.date) return null;
    const ms = zonedDateTimeToUtc(row.date, slot, zone);
    return Number.isFinite(ms) ? ms : null;
}

const KIND_RANK = { start: 0, slot: 1, day_start: 2 };

/**
 * @returns {{ locked: boolean, lockAt: number, kind: 'status'|'start'|'slot'|'day_start'|'unknown' }}
 */
export function lockDecision(row, now) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (statusLocks(row?.status)) return { locked: true, lockAt: nowMs, kind: 'status' };
    const options = [];
    const start = Date.parse(row?.startsAtUtc || '');
    if (Number.isFinite(start)) options.push({ at: start, kind: 'start' });
    const slot = orderOfPlayUtc(row);
    if (slot != null) options.push({ at: slot, kind: 'slot' });
    // Day start is not a candidate once a start time or a slot exists.
    if (!options.length && /^\d{4}-\d{2}-\d{2}$/.test(row?.date || '')) {
        const at = earlierDayStartUtc(row.date, timeZoneOf(row));
        if (Number.isFinite(at)) options.push({ at, kind: 'day_start' });
    }
    if (!options.length) return { locked: true, lockAt: nowMs, kind: 'unknown' };
    options.sort((a, b) => a.at - b.at || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    const earliest = options[0];
    return { locked: nowMs >= earliest.at, lockAt: earliest.at, kind: earliest.kind };
}
