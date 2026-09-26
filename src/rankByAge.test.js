import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    rankByAge,
    buildPlayerRankRecord,
    weeksFromDays,
    ageAtRankingsStart,
    MIN_RANKED_WEEKS,
} from './rankByAge.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(dir, 'fixtures/vintageRankByAge.json'), 'utf8'));
const spotcheck = readFileSync(join(dir, 'fixtures/rank_by_age_spotcheck.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map(line => {
        const [player, age, rank, weeksAtRank, rankedWeeks, totalWeeks, trueMajority, medianRank, bestRank, rawCountMode] = line.split(',');
        return {
            player,
            age: Number(age),
            rank: Number(rank),
            weeksAtRank: Number(weeksAtRank),
            rankedWeeks: Number(rankedWeeks),
            totalWeeks: Number(totalWeeks),
            trueMajority,
            medianRank: Number(medianRank),
            bestRank: Number(bestRank),
            rawCountMode: rawCountMode === 'None' ? null : Number(rawCountMode),
        };
    });

function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weeklyFrom(start, weeks) {
    const dates = [];
    for (let i = 0; i < weeks; i++) dates.push(addDays(start, i * 7));
    return dates;
}

function compute(name, minWeeks) {
    const player = fixture.players[name];
    return rankByAge({
        birthday: player.birthday,
        rankingDates: fixture.dates,
        ranksByDate: player.ranks,
        asOf: fixture.asOf,
        minWeeks,
    });
}

describe('vintage rank-by-age spot checks', () => {
    it('uses the Day-1 ATP calendar (1973-08-27 through 2026-06-08, 2333 weeks)', () => {
        expect(fixture.dates).toHaveLength(2333);
        expect(fixture.dates[0]).toBe('1973-08-27');
        expect(fixture.dates.at(-1)).toBe('2026-06-08');
        expect(fixture.rankingsStart).toBe('1973-08-27');
        expect(fixture.asOf).toBe('2026-06-08');
    });

    it('matches every Analytics row, including years the 13-week rule later drops', () => {
        const byPlayer = {};
        for (const name of ['Federer', 'Sampras', 'Agassi']) {
            const { years } = compute(name, 0);
            byPlayer[name] = new Map(years.map(y => [y.age, y]));
        }
        expect(spotcheck.length).toBeGreaterThan(0);
        for (const row of spotcheck) {
            const got = byPlayer[row.player].get(row.age);
            expect(got, `${row.player} age ${row.age}`).toBeTruthy();
            expect(got.rank, `${row.player} ${row.age} rank`).toBe(row.rank);
            expect(got.weeksAtRank, `${row.player} ${row.age} weeksAtRank`).toBe(row.weeksAtRank);
            expect(got.rankedWeeks, `${row.player} ${row.age} rankedWeeks`).toBe(row.rankedWeeks);
        }
        for (const name of ['Federer', 'Sampras', 'Agassi']) {
            const expectedAges = spotcheck.filter(r => r.player === name).map(r => r.age);
            expect([...byPlayer[name].keys()]).toEqual(expectedAges);
        }
    });

    it('keeps the majority-weeks rank and drops years under 13 ranked weeks', () => {
        const federer = compute('Federer', MIN_RANKED_WEEKS).years;
        const sampras = compute('Sampras', MIN_RANKED_WEEKS).years;
        const agassi = compute('Agassi', MIN_RANKED_WEEKS).years;

        for (const age of [22, 23, 24, 25, 26, 28]) {
            expect(federer.find(y => y.age === age)?.rank).toBe(1);
        }
        // Age 35's most common list-rank is 16; the rank held the most weeks is 4.
        const fed35 = federer.find(y => y.age === 35);
        expect(fed35.rank).toBe(4);
        expect(fed35.rank).not.toBe(16);
        expect(fed35.weeksAtRank).toBe(9);

        for (const age of [22, 23, 24, 25, 26, 27]) {
            expect(sampras.find(y => y.age === age)?.rank).toBe(1);
        }
        expect(sampras.find(y => y.age === 32)).toBeUndefined();

        expect(agassi.find(y => y.age === 25)?.rank).toBe(1);
        expect(agassi.find(y => y.age === 29)?.rank).toBe(1);
        // Rank 150 must survive — a top-100 slice of the weekly list would drop this year.
        expect(agassi.find(y => y.age === 36)?.rank).toBe(150);
        expect(agassi.find(y => y.age === 37)).toBeUndefined();

        const unfiltered = {
            Federer: compute('Federer', 0).years,
            Sampras: compute('Sampras', 0).years,
            Agassi: compute('Agassi', 0).years,
        };
        expect(unfiltered.Sampras.find(y => y.age === 32).rankedWeeks).toBe(3.9);
        expect(unfiltered.Agassi.find(y => y.age === 37).rankedWeeks).toBe(0.1);
        for (const years of [federer, sampras, agassi]) {
            expect(years.every(y => y.rankedWeeks >= 13 && y.partial === false)).toBe(true);
        }
    });

    it('reports age at the 1973 rankings start without treating later births as affected', () => {
        expect(compute('Federer', 13).ageAtRankingsStart).toBeNull();
        expect(ageAtRankingsStart('1981-08-08', '1973-08-27')).toBeNull();
        expect(ageAtRankingsStart('1971-08-12', '1973-08-27')).toBe(2);
        expect(ageAtRankingsStart('1970-04-29', '1973-08-27')).toBe(3);
        expect(compute('Sampras', 13).ageAtRankingsStart).toBe(2);
        expect(compute('Agassi', 13).ageAtRankingsStart).toBe(3);
    });
});

describe('rank-by-age rules', () => {
    it('counts days a ranking stood, not the number of lists (2020-style freeze)', () => {
        const dates = ['2020-03-09', '2020-03-16', '2020-08-24', '2020-08-31'];
        const days = Math.round((Date.UTC(2020, 7, 24) - Date.UTC(2020, 2, 16)) / 86400000);
        expect(days).toBeGreaterThan(20 * 7);
        const { years } = rankByAge({
            birthday: '1990-01-01',
            rankingDates: dates,
            ranksByDate: { '2020-03-16': 1 },
            asOf: '2020-08-31',
            minWeeks: 0,
        });
        expect(years).toHaveLength(1);
        expect(years[0].age).toBe(30);
        expect(years[0].rank).toBe(1);
        expect(years[0].weeksAtRank).toBe(weeksFromDays(days));
        expect(years[0].weeksAtRank).toBeGreaterThan(20);
        expect(years[0].partial).toBe(true);
    });

    it('includes a single 91-day list and omits a 90-day list', () => {
        const held = rankByAge({
            birthday: '1990-01-01',
            rankingDates: ['2020-01-01', '2020-04-01', '2021-01-01'],
            ranksByDate: { '2020-01-01': 8 },
            asOf: '2021-01-01',
        });
        expect(held.years).toEqual([
            { age: 30, rank: 8, weeksAtRank: 13, rankedWeeks: 13, partial: false },
        ]);

        const short = rankByAge({
            birthday: '1990-01-01',
            rankingDates: ['2020-01-01', '2020-03-31', '2021-01-01'],
            ranksByDate: { '2020-01-01': 8 },
            asOf: '2021-01-01',
        });
        expect(short.years).toEqual([]);
    });

    it('breaks ties toward the better rank and leaves a gap instead of zero', () => {
        // 7 weeks each (49 days) — equal time, so the better rank wins, and the
        // year still clears the 13-week bar (98 ranked days).
        const dates = weeklyFrom('2010-01-04', 15);
        const tie = {};
        for (let i = 0; i < 7; i++) tie[dates[i]] = 12;
        for (let i = 7; i < 14; i++) tie[dates[i]] = 7;
        const tied = rankByAge({
            birthday: '1990-01-01',
            rankingDates: dates,
            ranksByDate: tie,
            asOf: dates.at(-1),
        });
        expect(tied.years.map(y => y.rank)).toEqual([7]);

        const majority = {};
        for (let i = 0; i < 8; i++) majority[dates[i]] = 12;
        for (let i = 8; i < 14; i++) majority[dates[i]] = 7;
        const won = rankByAge({
            birthday: '1990-01-01',
            rankingDates: dates,
            ranksByDate: majority,
            asOf: dates.at(-1),
        });
        expect(won.years.map(y => y.rank)).toEqual([12]);

        const span = weeklyFrom('2010-01-04', 160);
        const ranks = {};
        for (const date of span) {
            if (date.startsWith('2010') || date.startsWith('2012')) ranks[date] = 5;
        }
        const gapped = rankByAge({
            birthday: '1990-01-01',
            rankingDates: span,
            ranksByDate: ranks,
            asOf: '2013-06-01',
        });
        expect(gapped.years.map(y => y.age)).toEqual([20, 22]);
        expect(gapped.years.every(y => y.rank === 5 && y.rank !== 0)).toBe(true);
    });

    it('marks only the age year that contains asOf as partial', () => {
        const dates = weeklyFrom('2018-01-01', 140);
        const ranks = {};
        for (let i = 0; i < dates.length - 1; i++) ranks[dates[i]] = 4;
        const asOf = '2020-06-08';
        const { years } = rankByAge({
            birthday: '1990-01-01',
            rankingDates: dates.filter(d => d <= asOf).concat([asOf]),
            ranksByDate: ranks,
            asOf,
        });
        const age29 = years.find(y => y.age === 29);
        const age30 = years.find(y => y.age === 30);
        expect(age29.partial).toBe(false);
        expect(age30.partial).toBe(true);
        expect(years.find(y => y.age === 31)).toBeUndefined();
    });

    it('does not put a birthday on the stored record', () => {
        const rec = buildPlayerRankRecord({
            name: 'Roger Federer',
            birthday: '1981-08-08',
            ranksByDate: fixture.players.Federer.ranks,
            rankingDates: fixture.dates,
        });
        expect(JSON.stringify(rec)).not.toContain('1981-08-08');
        expect(rec.reason).toBeUndefined();
        expect(rec.years.find(y => y.age === 35).rank).toBe(4);
        expect(rec.years.find(y => y.age === 22).rank).toBe(1);

        const missing = buildPlayerRankRecord({
            name: 'No Date',
            birthday: null,
            ranksByDate: {},
            rankingDates: fixture.dates,
        });
        expect(missing.reason).toBe('no-birthday');
        expect(missing.years).toEqual([]);
        expect(missing.birthday).toBeUndefined();
        expect(missing.dob).toBeUndefined();
    });
});
