import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignSlotOrder } from './bracketSlots.js';
import { drawOrderFields } from './routes/draws.js';
import { handleImportOfficialDraw } from './routes/officialDrawAdmin.js';
import {
    buildOfficialRecord,
    firstRoundChecksum,
    mapOfficialPairs,
    parseOfficialFirstRound,
    surnameMatches,
    validateOfficialRecord,
} from './officialDraw.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'mocks/official');

function loadJson(name) {
    return JSON.parse(readFileSync(join(DIR, name), 'utf8'));
}
function loadText(name) {
    return readFileSync(join(DIR, name), 'utf8');
}
function cloneRounds(payload) {
    const data = payload.data || payload;
    return JSON.parse(JSON.stringify(data.rounds));
}

// Surnames from the comparison script (cmp.py OFF). Token-boundary match
// against the sheet, so "Zandschulp" hits "VAN DE ZANDSCHULP".
const EXPECTED = {
    '16746': [['Semenistaja', 'Kinoshita'], ['Kostovic', 'Barros'], ['Leme Da Silva', 'Sharma'], ['Tikhonova', 'Quevedo'], ['Blinkova', 'Lee'], ['Valdmannova', 'Pigossi'], ['Riera', 'Avanesyan'], ['You', 'Charaeva'], ['Lys', 'Ce'], ['Stefanini', 'Podoroska'], ['Lamens', 'Alves'], ['Brace', 'Sierra'], ['Bouzas Maneiro', 'Salkova'], ['Stoiana', 'Liu'], ['Ortenzi', 'Paquet'], ['Mikulskyte', 'Badosa']],
    '16747': [['Andreeva', 'Bye'], ['Kasatkina', 'Sasnovich'], ['Parks', 'Yamaguchi'], ['Okamura', 'Fernandez'], ['Mertens', 'Bye'], ['Krejcikova', 'Friedsam'], ['Wolff', 'Oliynykova'], ['Sramkova', 'Chwalinska'], ['Vekic', 'Wang'], ['Hunter', 'Garland'], ['Prozorova', 'Costoulas'], ['Bye', 'Eala'], ['Sakkari', 'Fruhvirtova'], ['Mladenovic', 'Hibino'], ['Gibson', 'Ferro'], ['Bye', 'Morvayova']],
    '16748': [['Ostapenko', 'Zakharova'], ['Preston', 'Sakatsume'], ['Korneeva', 'Sawangkaew'], ['Astakhova', 'Linette'], ['Tararudee', 'Uchijima'], ['Park', 'Montgomery'], ['Yuan', 'Back'], ['Yao', 'Joint'], ['Bondar', 'Zarazua'], ['Charaeva', 'Kenin'], ['Ibragimova', 'Ku'], ['Lys', 'Ruse'], ['Rakhimova', 'Kudermetova'], ['Volynets', 'Kalieva'], ['Jones', 'Ma'], ['Zidansek', 'Birrell']],
    '21351': [['Vacherot', 'Bye'], ['Harris', 'Kovacevic'], ['Damm', 'Mochizuki'], ['Shevchenko', 'Hurkacz'], ['Tabilo', 'Bye'], ['Shang', 'Mannarino'], ['Kopriva', 'Hu'], ['Griekspoor', 'Shapovalov'], ['Baez', 'Brooksby'], ['Duckworth', 'Sonego'], ['Kecmanovic', 'Basilashvili'], ['Bye', 'Zandschulp'], ['Cina', 'Carabelli'], ['Kouame', 'Muller'], ['Cerundolo', 'Zhou'], ['Bye', 'Davidovich Fokina']],
    '21352': [['Medvedev', 'Bye'], ['Royer', 'Walton'], ['Zhang', 'Wong'], ['Cui', 'Vallejo'], ['Halys', 'Bye'], ['Sun', 'Safiullin'], ['Bu', 'Zheng'], ['Bellucci', 'Majchrzak'], ['Marozsan', 'Bolt'], ['Sweeny', 'Daniel'], ['Vukic', 'Jacquet'], ['Bye', 'Etcheverry'], ['Faria', 'Atmane'], ['Shimabukuro', 'Gaston'], ['Hijikata', 'Svrcina'], ['Bye', 'Rublev']],
};

const EVENTS = [
    { key: '21352', file: '21352-hangzhou', tour: 'ATP', host: 'atptour.com', name: 'Hangzhou Open - Hangzhou' },
    { key: '21351', file: '21351-chengdu', tour: 'ATP', host: 'atptour.com', name: 'Chengdu Open - Chengdu' },
    { key: '16746', file: '16746-saopaulo', tour: 'WTA', host: 'wtatennis.com', name: 'SP Open - Sao Paulo' },
    { key: '16747', file: '16747-singapore', tour: 'WTA', host: 'wtatennis.com', name: 'Singapore Tennis Open - Singapore' },
    { key: '16748', file: '16748-seoul', tour: 'WTA', host: 'wtatennis.com', name: 'Korea Open - Seoul' },
];

function sameSide(got, exp) {
    return surnameMatches(got, exp) || surnameMatches(exp, got);
}

function recordFor(event, rounds, pairs = EXPECTED[event.key]) {
    const mapped = mapOfficialPairs(rounds, pairs);
    expect(mapped.ok, (mapped.unmapped || []).join(', ')).toBe(true);
    const built = buildOfficialRecord({
        tournamentKey: event.key,
        season: '2026',
        tour: event.tour,
        sourceHost: event.host,
        checkedAt: '2026-09-26',
        slots: mapped.slots,
    });
    expect(built.ok, built.error).toBe(true);
    return built.record;
}

function firstRound(rounds) {
    return rounds.reduce((a, b) => (b.order > a.order ? b : a));
}

function roundNamed(rounds, re) {
    return rounds.find(r => re.test(r.round));
}

describe('official sheet parser', () => {
    for (const event of EVENTS) {
        it(`${event.file} first round matches the printed pairs`, () => {
            const parsed = parseOfficialFirstRound(loadText(`${event.file}.txt`));
            expect(parsed.ok, parsed.error).toBe(true);
            expect(parsed.pairs).toHaveLength(EXPECTED[event.key].length);
            parsed.pairs.forEach((pair, i) => {
                const exp = EXPECTED[event.key][i];
                expect(sameSide(pair[0], exp[0]), `${i} top ${pair[0]} vs ${exp[0]}`).toBe(true);
                expect(sameSide(pair[1], exp[1]), `${i} bot ${pair[1]} vs ${exp[1]}`).toBe(true);
            });
        });
    }

    it('does not map a surname that is only a suffix of another name', () => {
        expect(surnameMatches('Cadence Brace', 'Ce')).toBe(false);
        expect(surnameMatches('Gabriela Ce', 'Ce')).toBe(true);
        expect(surnameMatches('Bu Yunchaokete', 'Bu')).toBe(true);
        expect(surnameMatches('Botic Van De Zandschulp', 'Zandschulp')).toBe(true);
    });
});

describe('official record applied to the five live draws', () => {
    for (const event of EVENTS) {
        it(`${event.name} is the printed first round and verified`, () => {
            const payload = loadJson(`${event.file}.json`);
            const rounds = cloneRounds(payload);
            const parsed = parseOfficialFirstRound(loadText(`${event.file}.txt`));
            expect(parsed.ok, parsed.error).toBe(true);
            const record = recordFor(event, rounds, parsed.pairs);
            const ordered = assignSlotOrder(rounds, event.tour, event.name, record);
            const r1 = firstRound(ordered).matches;

            expect(ordered[0].slotOrderVerified).toBe(true);
            expect(ordered[0].slotOrderMismatch).toBeUndefined();
            expect(ordered.slotOrderVerification).toEqual({
                tour: event.tour,
                sourceHost: event.host,
                checkedAt: '2026-09-26',
            });
            expect(drawOrderFields(ordered)).toMatchObject({
                slotOrderVerified: true,
                slotOrderVerification: ordered.slotOrderVerification,
            });
            expect(drawOrderFields(ordered).slotOrderMismatch).toBeUndefined();

            EXPECTED[event.key].forEach((exp, i) => {
                expect(sameSide(r1[i].player1Name, exp[0]), `${event.key} slot ${i} top`).toBe(true);
                expect(sameSide(r1[i].player2Name, exp[1]), `${event.key} slot ${i} bottom`).toBe(true);
                expect(r1[i].slotIndex).toBe(i);
            });
        });
    }

    it('Hangzhou semis are Medvedev/Wong vs Safiullin/Bu and Marozsan/Jacquet vs Gaston/Rublev', () => {
        const event = EVENTS[0];
        const rounds = cloneRounds(loadJson(`${event.file}.json`));
        const parsed = parseOfficialFirstRound(loadText(`${event.file}.txt`));
        const ordered = assignSlotOrder(rounds, event.tour, event.name, recordFor(event, rounds, parsed.pairs));
        const qf = roundNamed(ordered, /quarter/i).matches;
        expect(qf).toHaveLength(4);
        const has = (m, a, b) => sameSide(m.player1Name, a) && sameSide(m.player2Name, b)
            || sameSide(m.player1Name, b) && sameSide(m.player2Name, a);
        expect(has(qf[0], 'Medvedev', 'Wong')).toBe(true);
        expect(has(qf[1], 'Safiullin', 'Bu')).toBe(true);
        expect(has(qf[2], 'Marozsan', 'Jacquet')).toBe(true);
        expect(has(qf[3], 'Gaston', 'Rublev')).toBe(true);
        // Adjacent QFs are the SF lines. 0-1 is one semi, 2-3 the other.
        expect(ordered[0].slotOrderVerified).toBe(true);
    });

    it('Chengdu orients Shevchenko above Hurkacz and flips the set scores', () => {
        const event = EVENTS[1];
        const rounds = cloneRounds(loadJson(`${event.file}.json`));
        const parsed = parseOfficialFirstRound(loadText(`${event.file}.txt`));
        const ordered = assignSlotOrder(rounds, event.tour, event.name, recordFor(event, rounds, parsed.pairs));
        const m = firstRound(ordered).matches[3];
        expect(m.player1Name).toMatch(/Shevchenko/);
        expect(m.player2Name).toMatch(/Hurkacz/);
        expect(m.winner).toBe('player2');
        expect(m.setScores).toEqual(['3-6', '6-7(10)']);
    });
});

describe('stale, unmapped, and structural mismatch', () => {
    function hangzhou() {
        const event = EVENTS[0];
        const rounds = cloneRounds(loadJson(`${event.file}.json`));
        const parsed = parseOfficialFirstRound(loadText(`${event.file}.txt`));
        return { event, rounds, record: recordFor(event, rounds, parsed.pairs) };
    }

    it('a checksum that no longer matches the slots is not verified', () => {
        const { event, rounds, record } = hangzhou();
        const stale = { ...record, checksum: '0'.repeat(64) };
        const ordered = assignSlotOrder(rounds, event.tour, event.name, stale);
        expect(ordered[0].slotOrderVerified).toBe(false);
        expect(ordered[0].slotOrderMismatch).toBeUndefined();
        expect(ordered.slotOrderVerification).toBeUndefined();
        expect(drawOrderFields(ordered)).toEqual({ slotOrderVerified: false });
    });

    it('a lucky-loser id change is stale, not verified and not wrong', () => {
        const { event, rounds, record } = hangzhou();
        const slots = record.slots.map(s => s.slice());
        slots[2] = [slots[2][0], '99999999'];
        const built = buildOfficialRecord({ ...record, slots });
        expect(built.ok).toBe(true);
        const ordered = assignSlotOrder(rounds, event.tour, event.name, built.record);
        expect(ordered[0].slotOrderVerified).toBe(false);
        expect(ordered[0].slotOrderMismatch).toBeUndefined();
        expect(drawOrderFields(ordered).slotOrderVerified).toBe(false);
    });

    it('an official name that does not map is rejected and the draw stays unchecked', () => {
        const { event, rounds } = hangzhou();
        const pairs = EXPECTED[event.key].map(p => p.slice());
        pairs[5] = ['Notarealperson', pairs[5][1]];
        const mapped = mapOfficialPairs(rounds, pairs);
        expect(mapped.ok).toBe(false);
        expect(mapped.unmapped.some(s => /Notarealperson/.test(s))).toBe(true);
        const ordered = assignSlotOrder(rounds, event.tour, event.name);
        expect(ordered[0].slotOrderVerified).toBe(false);
        expect(ordered[0].slotOrderMismatch).toBeUndefined();
        expect(drawOrderFields(ordered)).toEqual({ slotOrderVerified: false });
    });

    it('a record that splits a played section is bracket-order wrong, not verified', () => {
        const { event, rounds, record } = hangzhou();
        const slots = record.slots.map(s => s.slice());
        [slots[0], slots[8]] = [slots[8], slots[0]];
        const built = buildOfficialRecord({ ...record, slots });
        expect(built.ok).toBe(true);
        const ordered = assignSlotOrder(rounds, event.tour, event.name, built.record);
        expect(ordered[0].slotOrderVerified).toBe(false);
        expect(ordered[0].slotOrderMismatch).toBe(true);
        expect(drawOrderFields(ordered)).toEqual({
            slotOrderVerified: false,
            slotOrderMismatch: true,
        });
        const qf = roundNamed(ordered, /quarter/i).matches;
        const top = `${qf[0].player1Name} ${qf[0].player2Name}`;
        expect(top).not.toMatch(/Medvedev/);
        expect(top).toMatch(/Safiullin/);
    });
});

describe('checksum', () => {
    it('hashes slot index and the set of ids, not seeds or side order', () => {
        const a = firstRoundChecksum([['2', '1'], ['BYE', '3']]);
        const b = firstRoundChecksum([['1', '2'], ['3', 'BYE']]);
        const c = firstRoundChecksum([['9', '1'], ['BYE', '3']]);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^[a-f0-9]{64}$/);
    });
});

function mockEnv(secret = 'test-admin-secret') {
    const store = new Map();
    return {
        ADMIN_SECRET: secret,
        TENNIS_CACHE: {
            async get(key, type) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                if (type === 'json') return JSON.parse(raw);
                return raw;
            },
            async put(key, value) { store.set(key, value); },
            async delete(key) { store.delete(key); },
            _store: store,
        },
    };
}

function post(body, secret) {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['x-admin-secret'] = secret;
    return new Request('https://example.test/api/admin/import-official-draw', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

describe('POST /api/admin/import-official-draw', () => {
    let env;
    beforeEach(() => { env = mockEnv(); });

    it('returns 401 without the secret and when the secret is unset', async () => {
        const body = { tournamentKey: '1' };
        await expect(handleImportOfficialDraw(post(body), env)).rejects.toMatchObject({ status: 401 });
        await expect(handleImportOfficialDraw(post(body, 'nope'), env)).rejects.toMatchObject({ status: 401 });
        const closed = mockEnv('');
        closed.ADMIN_SECRET = '';
        await expect(handleImportOfficialDraw(post(body, 'test-admin-secret'), closed)).rejects.toMatchObject({ status: 401 });
    });

    it('writes one record and rejects a bad host, a bad checksum, and seeds', async () => {
        const event = EVENTS[0];
        const rounds = cloneRounds(loadJson(`${event.file}.json`));
        const record = recordFor(event, rounds, parseOfficialFirstRound(loadText(`${event.file}.txt`)).pairs);

        const written = await handleImportOfficialDraw(post(record, env.ADMIN_SECRET), env);
        expect(written.written).toBe(true);
        expect(written.slots).toBe(16);
        const stored = [...env.TENNIS_CACHE._store.keys()].filter(k => k.startsWith('tw:official-draw:'));
        expect(stored).toEqual(['tw:official-draw:v1:ATP:21352:2026']);
        const again = await handleImportOfficialDraw(post(record, env.ADMIN_SECRET), env);
        expect(again.written).toBe(false);

        await expect(handleImportOfficialDraw(post({ ...record, sourceHost: 'evil.example' }, env.ADMIN_SECRET), env))
            .rejects.toMatchObject({ status: 400 });
        await expect(handleImportOfficialDraw(post({ ...record, checksum: 'ab' }, env.ADMIN_SECRET), env))
            .rejects.toMatchObject({ status: 400 });
        await expect(handleImportOfficialDraw(post({ ...record, seeds: [1] }, env.ADMIN_SECRET), env))
            .rejects.toMatchObject({ status: 400 });

        expect(validateOfficialRecord(record).ok).toBe(true);
    });
});
