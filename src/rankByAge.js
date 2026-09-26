// Rank-by-age for Vintage Curves.
//
// Age year = from a birthday to the next birthday (age 22 starts on the 22nd
// birthday). A published ranking counts for as long as it stood: the days until
// the next ranking date, divided by 7. That is not "one week per list" — gaps
// between lists (pre-1984 monthly lists, skipped Slam weeks, the 2020 freeze)
// keep the previous rank in force.
//
// The plotted rank is the one held for the most days in that age year. A tie
// goes to the better (lower) rank. A year is omitted unless it has at least
// 13 ranked weeks (91 days). Omission is a gap, never rank 0.
//
// `asOf` is the last ranking date in the calendar passed in, not the wall clock.
// The age year that contains `asOf` is partial. Birth dates stay in this module;
// callers must not put them on the response.

const DAY = 24 * 60 * 60 * 1000;

export const MIN_RANKED_WEEKS = 13;
export const MIN_RANKED_DAYS = MIN_RANKED_WEEKS * 7; // 91
export const TOP_RANK = 200;

const LEGEND_RE = /^s(\d+)$/i;
const NUMERIC_RE = /^\d{1,20}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function canonicalPlayerKey(raw) {
    if (raw == null) return null;
    const key = String(raw).trim();
    const legend = key.match(LEGEND_RE);
    if (legend) return `s${legend[1]}`;
    if (NUMERIC_RE.test(key)) return key;
    return null;
}

export function weeksFromDays(days) {
    return Math.round((days * 10) / 7) / 10;
}

function utcDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function addYears(ms, n) {
    const dt = new Date(ms);
    // Feb 29 overflows to March 1 in a non-leap target year.
    return Date.UTC(dt.getUTCFullYear() + n, dt.getUTCMonth(), dt.getUTCDate());
}

function ageOn(birthMs, dateMs) {
    let age = new Date(dateMs).getUTCFullYear() - new Date(birthMs).getUTCFullYear();
    if (dateMs < addYears(birthMs, age)) age--;
    return age;
}

function asIsoDate(value) {
    if (typeof value !== 'string') return null;
    const day = value.slice(0, 10);
    return ISO_RE.test(day) ? day : null;
}

function rankOn(ranksByDate, date) {
    if (!ranksByDate) return null;
    const raw = ranksByDate instanceof Map ? ranksByDate.get(date) : ranksByDate[date];
    const rank = Number(raw);
    if (!Number.isInteger(rank) || rank < 1 || rank > TOP_RANK) return null;
    return rank;
}

// Integer age on the first ranking date, or null if the player was not yet born.
// Not a birth date — the UI uses it only to decide whether the pre-1973 note applies.
export function ageAtRankingsStart(birthday, rankingsStart) {
    const birth = asIsoDate(birthday);
    const start = asIsoDate(rankingsStart);
    if (!birth || !start) return null;
    const birthMs = utcDay(birth);
    const startMs = utcDay(start);
    if (birthMs > startMs) return null;
    const age = ageOn(birthMs, startMs);
    if (!Number.isInteger(age) || age < 0 || age > 120) return null;
    return age;
}

/**
 * @param {object} input
 * @param {string} input.birthday  YYYY-MM-DD (server-side only)
 * @param {string[]} input.rankingDates  every ranking date, not only this player's
 * @param {Map<string, number>|Record<string, number>} input.ranksByDate
 * @param {string} [input.asOf]  defaults to the last ranking date
 * @param {number} [input.minWeeks]  default 13; tests pass 0 to see omitted years
 */
export function rankByAge({ birthday, rankingDates, ranksByDate, asOf, minWeeks = MIN_RANKED_WEEKS }) {
    const birth = asIsoDate(birthday);
    const dates = [...new Set((rankingDates || []).filter(d => ISO_RE.test(d)))].sort();
    const empty = {
        asOf: asIsoDate(asOf) || dates[dates.length - 1] || null,
        rankingsStart: dates[0] || null,
        ageAtRankingsStart: null,
        years: [],
    };
    if (!birth || dates.length < 2) {
        empty.ageAtRankingsStart = ageAtRankingsStart(birth, empty.rankingsStart);
        return empty;
    }

    const birthMs = utcDay(birth);
    const asOfIso = asIsoDate(asOf) || dates[dates.length - 1];
    const asOfMs = utcDay(asOfIso);
    const minDays = minWeeks * 7;
    const buckets = new Map();

    for (let i = 0; i < dates.length - 1; i++) {
        const rank = rankOn(ranksByDate, dates[i]);
        if (rank == null) continue;
        let start = utcDay(dates[i]);
        let end = utcDay(dates[i + 1]);
        if (!(end > start)) continue;
        if (start >= asOfMs) continue;
        if (end > asOfMs) end = asOfMs;

        let cursor = start;
        while (cursor < end) {
            const age = ageOn(birthMs, cursor);
            const ageEnd = addYears(birthMs, age + 1);
            const sliceEnd = Math.min(end, ageEnd);
            const days = Math.round((sliceEnd - cursor) / DAY);
            if (days > 0 && age >= 0 && age <= 80) {
                let bucket = buckets.get(age);
                if (!bucket) {
                    bucket = new Map();
                    buckets.set(age, bucket);
                }
                bucket.set(rank, (bucket.get(rank) || 0) + days);
            }
            if (sliceEnd <= cursor) break;
            cursor = sliceEnd;
        }
    }

    const years = [];
    for (const age of [...buckets.keys()].sort((a, b) => a - b)) {
        const byRank = buckets.get(age);
        let rankedDays = 0;
        let bestRank = null;
        let bestDays = -1;
        for (const [rank, days] of byRank) {
            rankedDays += days;
            if (days > bestDays || (days === bestDays && (bestRank == null || rank < bestRank))) {
                bestRank = rank;
                bestDays = days;
            }
        }
        if (rankedDays < minDays) continue;
        const ageStart = addYears(birthMs, age);
        const ageEnd = addYears(birthMs, age + 1);
        years.push({
            age,
            rank: bestRank,
            weeksAtRank: weeksFromDays(bestDays),
            rankedWeeks: weeksFromDays(rankedDays),
            partial: asOfMs >= ageStart && asOfMs < ageEnd,
        });
    }

    return {
        asOf: asOfIso,
        rankingsStart: dates[0],
        ageAtRankingsStart: ageAtRankingsStart(birth, dates[0]),
        years,
    };
}

// KV record for one player. Birthday is an input and is not copied onto the record.
export function buildPlayerRankRecord({ name, birthday, ranksByDate, rankingDates }) {
    const dates = [...new Set((rankingDates || []).filter(d => ISO_RE.test(d)))].sort();
    const asOf = dates[dates.length - 1] || null;
    const rankingsStart = dates[0] || null;
    const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
    if (!asIsoDate(birthday)) {
        return {
            name: cleanName,
            asOf,
            rankingsStart,
            ageAtRankingsStart: null,
            years: [],
            reason: 'no-birthday',
        };
    }
    const computed = rankByAge({ birthday, ranksByDate, rankingDates: dates });
    const rec = {
        name: cleanName,
        asOf: computed.asOf,
        rankingsStart: computed.rankingsStart,
        ageAtRankingsStart: computed.ageAtRankingsStart,
        years: computed.years,
    };
    if (!computed.years.length) rec.reason = 'no-ranking-history';
    return rec;
}
