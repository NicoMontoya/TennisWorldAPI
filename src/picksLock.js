// Lock instant for a tour singles match. The client clock is never an input.
// Earliest of: a status that has left Not Started; startsAtUtc; an
// order-of-play slot when the start instant is missing; otherwise the earlier
// of tournament-local midnight and UTC midnight at the end of the match date.

const LOCKING = new Set(['Live', 'Delayed', 'Finished', 'Walkover', 'Cancelled']);

export function statusLocks(status) {
    return LOCKING.has(status);
}

export function timeZoneOf(row) {
    const raw = row?.timeZone || row?.timezone || row?.tournamentTimeZone || '';
    if (typeof raw !== 'string') return '';
    const zone = raw.trim();
    if (!zone || zone.length > 64) return '';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
        return zone;
    } catch {
        return '';
    }
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

function nextDate(date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
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

/** End of the match date, the earlier of local midnight and UTC midnight. */
export function earlierMidnightUtc(date, timeZone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return NaN;
    const utcEnd = Date.parse(`${date}T00:00:00.000Z`) + 86_400_000;
    const zone = timeZoneOf({ timeZone });
    if (!zone) return utcEnd;
    const localEnd = zonedDateTimeToUtc(nextDate(date), '00:00', zone);
    if (!Number.isFinite(localEnd)) return utcEnd;
    return Math.min(utcEnd, localEnd);
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

/**
 * @returns {{ locked: boolean, lockAt: number, kind: 'status'|'start'|'slot'|'midnight'|'unknown' }}
 */
export function lockDecision(row, now) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (statusLocks(row?.status)) return { locked: true, lockAt: nowMs, kind: 'status' };
    const start = Date.parse(row?.startsAtUtc || '');
    if (Number.isFinite(start)) return { locked: nowMs >= start, lockAt: start, kind: 'start' };
    const slot = orderOfPlayUtc(row);
    if (slot != null) return { locked: nowMs >= slot, lockAt: slot, kind: 'slot' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(row?.date || '')) {
        const lockAt = earlierMidnightUtc(row.date, timeZoneOf(row));
        return { locked: nowMs >= lockAt, lockAt, kind: 'midnight' };
    }
    return { locked: true, lockAt: nowMs, kind: 'unknown' };
}
