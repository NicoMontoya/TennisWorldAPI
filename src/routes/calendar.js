import { getCalendarYear } from '../calendarYear.js';
import { parseTour } from '../security.js';
import { tagAsOf } from '../asOf.js';
import { readTournaments } from '../d1Store.js';

// court.name → surface label
function parseSurface(courtName) {
    if (!courtName) return 'Hard';
    const c = courtName.toLowerCase();
    if (c.includes('clay'))  return 'Clay';
    if (c.includes('grass')) return 'Grass';
    if (c.includes('carpet'))return 'Carpet';
    return 'Hard';
}

// Derive tournament status relative to today
function deriveStatus(startDateStr) {
    if (!startDateStr) return 'upcoming';
    const start   = new Date(startDateStr);
    const now     = new Date();
    const msSince = now - start;
    const daysSince = msSince / 86_400_000;
    if (daysSince < 0)  return 'upcoming';
    if (daysSince < 14) return 'live';      // rough: tournament window ≈ 1–2 weeks
    return 'completed';
}

// Tier priority: lower = more important (shown first)
const TIER_ORDER = {
    'Grand Slam':      1,
    'ATP Masters 1000':2, 'WTA 1000': 2,
    'ATP 500':         3, 'WTA 500':  3,
    'ATP 250':         4, 'WTA 250':  4,
    'Finals':          4,
};
function tierPriority(tier) {
    if (!tier) return 99;
    for (const [key, val] of Object.entries(TIER_ORDER)) {
        if (tier.includes(key)) return val;
    }
    return tier.includes('Challenger') ? 5 : 9; // Challenger=5, Future/ITF=9
}

function pageRows(page) {
    return page?.data || (Array.isArray(page) ? page : []);
}

// Main-tour week (or requested window) from raw calendar rows.
export function shapeCalendar(allTournaments, dateStart, dateStop) {
    const rangeStart = new Date(dateStart + 'T00:00:00Z');
    const rangeStop  = new Date(dateStop  + 'T23:59:59Z');
    const MAX_DURATION_MS = 21 * 86_400_000;

    const MAIN_TOUR_TIERS = ['Grand Slam', 'ATP Masters 1000', 'WTA 1000', 'ATP 500', 'WTA 500', 'ATP 250', 'WTA 250', 'Finals'];
    function isMainTour(tier) {
        if (!tier) return false;
        return MAIN_TOUR_TIERS.some(t => tier.includes(t));
    }

    const filtered = (allTournaments || []).filter(t => {
        if (!t.date) return false;
        if (!isMainTour(t.tier)) return false;
        const start = new Date(t.date);
        const end   = new Date(start.getTime() + MAX_DURATION_MS);
        return start <= rangeStop && end >= rangeStart;
    });

    const tournaments = filtered.map(t => {
        const status = deriveStatus(t.date);
        return {
            tournamentKey: String(t.id),
            name:          t.name || '',
            surface:       parseSurface(t.court?.name),
            season:        new Date(t.date || Date.now()).getFullYear(),
            startDate:     t.date ? t.date.split('T')[0] : '',
            endDate:       '',
            status,
            tier:          t.tier || '',
            country:       t.coutry?.name  || '',
            countryCode:   t.coutry?.acronym || '',
            finished:      status === 'completed' ? 1 : 0,
            live:          status === 'live'      ? 1 : 0,
            upcoming:      status === 'upcoming'  ? 1 : 0,
            totalMatches:  t.draw_size || 0,
        };
    });

    tournaments.sort((a, b) => {
        const ta = tierPriority(a.tier), tb = tierPriority(b.tier);
        if (ta !== tb) return ta - tb;
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return (b.startDate || '').localeCompare(a.startDate || '');
    });

    return tournaments;
}

function weekWindow(searchParams) {
    let dateStart = searchParams.get('dateStart');
    let dateStop  = searchParams.get('dateStop');
    if (!dateStart || !dateStop) {
        const today     = new Date();
        const dayOfWeek = today.getDay();
        const monday    = new Date(today);
        monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7));
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        dateStart = monday.toISOString().split('T')[0];
        dateStop  = sunday.toISOString().split('T')[0];
    }
    return { dateStart, dateStop };
}

// GET /api/calendar?tour=ATP|WTA&dateStart=YYYY-MM-DD&dateStop=YYYY-MM-DD
// The body is still the filtered week (or the requested window). The upstream
// read is the shared yearly cache; dateStart/dateStop are applied in memory
// and are not part of any cache key. A failed or hard-stopped pull serves the
// last D1 copy (then the KV stale year) with asOf, or [] when nothing was stored.
export async function handleCalendar(request, env) {
    const { searchParams } = new URL(request.url);
    const tour = parseTour(searchParams.get('tour'));
    const { dateStart, dateStop } = weekWindow(searchParams);

    const startYear = new Date(dateStart).getFullYear();
    const stopYear  = new Date(dateStop).getFullYear();
    const years     = [...new Set([startYear, stopYear])];

    let pages = [];
    try {
        pages = await Promise.all(years.map(y => getCalendarYear(env, tour, y)));
    } catch (err) {
        if (err?.status === 400) throw err;
        return serveStoredCalendar(env, tour, dateStart, dateStop, []);
    }

    if (pages.some(page => page?.source === 'stale')) {
        return serveStoredCalendar(env, tour, dateStart, dateStop, pages);
    }

    const merged = pages.flatMap(pageRows);
    return shapeCalendar(merged, dateStart, dateStop);
}

async function serveStoredCalendar(env, tour, dateStart, dateStop, pages) {
    const saved = await readTournaments(env, tour);
    if (saved?.hadRows) {
        return tagAsOf(shapeCalendar(saved.rows, dateStart, dateStop), saved.asOf);
    }
    const staleRows = (pages || []).flatMap(pageRows);
    if (staleRows.length) {
        const asOf = (pages || []).map(page => page?.fetchedAt).filter(Boolean).sort().at(-1);
        const shaped = shapeCalendar(staleRows, dateStart, dateStop);
        return asOf ? tagAsOf(shaped, asOf) : shaped;
    }
    return [];
}
