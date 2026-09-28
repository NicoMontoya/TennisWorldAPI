import { cache } from './cache.js';
import { rapidAPI } from './apiClient.js';
import { parseTour } from './security.js';

// Full-year tournament calendar, shared by livescore, hub, /api/calendar,
// the cron warm, and (for in-window seasons) the player tournament maps.
// One RapidAPI calendar() per tour+year, then 24h on KV and the edge.
// The key is only a tour that passed parseTour and a 4-digit year inside
// the current year ±1. Anything else throws 400 before a cache read or write.

export const CALENDAR_YEAR_TTL = 24 * 60 * 60;
const KEY = 'calendar-year';

function httpError(status, message) {
    throw Object.assign(new Error(message), { status });
}

/** 'YYYY' when year is four digits and within now's calendar year ±1, else null. */
export function calendarYearInWindow(yearRaw, now = new Date()) {
    const year = String(yearRaw ?? '').trim();
    if (!/^\d{4}$/.test(year)) return null;
    const current = now.getFullYear();
    const n = Number(year);
    if (n < current - 1 || n > current + 1) return null;
    return year;
}

export async function getCalendarYear(env, tourRaw, yearRaw, now = new Date()) {
    const tour = parseTour(tourRaw);
    const year = calendarYearInWindow(yearRaw, now);
    if (!year) httpError(400, 'Invalid year. Expected the current year ±1.');

    const cached = await cache.get(env, KEY, tour, year);
    if (cached?.data) return cached.data;

    try {
        const cal = await rapidAPI.calendar(env, tour, year);
        const payload = { data: cal?.data || (Array.isArray(cal) ? cal : []) };
        await cache.set(env, CALENDAR_YEAR_TTL, payload, KEY, tour, year);
        return payload;
    } catch (err) {
        const stale = await cache.getStale(env, KEY, tour, year);
        if (stale?.data) return stale.data;
        throw err;
    }
}

// Tournament maps and the vintage tier map also need seasons older than
// current ±1. Those years stay on calendar() and never mint a calendar-year
// key. In-window years share getCalendarYear. A bad tour still 400s — the
// fallback is only for a year outside the window.
export function calendarYearFor(env, tour, year, now = new Date()) {
    if (!calendarYearInWindow(year, now)) return rapidAPI.calendar(env, tour, year);
    return getCalendarYear(env, tour, year, now);
}
