import { describe, it, expect } from 'vitest';
import { assignSlotOrder, getBracketSlots } from './bracketSlots.js';

function mkMatch(partial) {
    return {
        matchKey: '0',
        player1Name: '', player1Key: '', player2Name: '', player2Key: '',
        winner: null, setScores: [], status: 'Not Started', isLive: false,
        date: '2026-09-14T12:00:00.000Z',
        player1Rank: null, player2Rank: null, player1Seed: null, player2Seed: null,
        ...partial,
    };
}

function names(m) {
    return [m.player1Name, m.player2Name];
}

function hasPair(m, a, b) {
    const n = names(m).map(s => (s || '').toLowerCase());
    const A = a.toLowerCase(), B = b.toLowerCase();
    return (n.some(s => s.includes(A)) && n.some(s => s.includes(B)));
}

function adjacentOk(earlier, later) {
    let ok = 0;
    for (let i = 0; i < later.length; i++) {
        const a = earlier[2 * i], b = earlier[2 * i + 1];
        if (!a || !b) continue;
        const laterKeys = [later[i].player1Key, later[i].player2Key].map(String);
        const feedKeys = [];
        for (const m of [a, b]) {
            if (m.winner === 'player1') feedKeys.push(String(m.player1Key));
            else if (m.winner === 'player2') feedKeys.push(String(m.player2Key));
            else {
                if (m.player1Key) feedKeys.push(String(m.player1Key));
                if (m.player2Key) feedKeys.push(String(m.player2Key));
            }
        }
        const hits = laterKeys.filter(k => k && k !== 'null' && feedKeys.includes(k)).length;
        if (hits >= 1) ok++;
    }
    return ok;
}

// Live Guadalajara 16745 first-round (12 real R32 matches; 4 byes unpublished)
// + 7 R16 (Kostyuk–Townsend WO missing) + QF/SF/F. matchKeys are the live ids
// so a matchKey sort would reproduce the scrambled production order.
function guadalajaraRaw() {
    const r32 = [
        mkMatch({ matchKey: '871466', player1Name: 'Magdalena Frech', player1Key: '17155', player2Name: 'Nao Hibino', player2Key: '13937', winner: 'player1' }),
        mkMatch({ matchKey: '871468', player1Name: 'Caroline Dolehide', player1Key: '28585', player2Name: 'Renata Zarazua', player2Key: '18403', winner: 'player1' }),
        mkMatch({ matchKey: '871482', player1Name: 'Liudmila Samsonova', player1Key: '24368', player2Name: 'Elsa Jacquemot', player2Key: '57147', winner: 'player1' }),
        mkMatch({ matchKey: '871481', player1Name: 'Kayla Day', player1Key: '30510', player2Name: 'Elvina Kalieva', player2Key: '55186', winner: 'player1' }),
        mkMatch({ matchKey: '871473', player1Name: 'Cristina Bucsa', player1Key: '24344', player2Name: 'Bianca Vanessa Andreescu', player2Key: '39226', winner: 'player1' }),
        mkMatch({ matchKey: '871485', player1Name: 'Panna Udvardy', player1Key: '43866', player2Name: 'Lois Boisson', player2Key: '60758', winner: 'player1' }),
        mkMatch({ matchKey: '871458', player1Name: 'Alycia Parks', player1Key: '45540', player2Name: 'Varvara Lepchenko', player2Key: '461', winner: 'player1' }),
        mkMatch({ matchKey: '871469', player1Name: 'Zeynep Sonmez', player1Key: '49991', player2Name: 'Iryna Shymanovich', player2Key: '18454', winner: 'player1' }),
        mkMatch({ matchKey: '871474', player1Name: 'Peyton Stearns', player1Key: '53793', player2Name: 'Emiliana Arango', player2Key: '39540', winner: 'player1' }),
        mkMatch({ matchKey: '871476', player1Name: 'Sloane Stephens', player1Key: '10033', player2Name: 'Carole Monnet', player2Key: '45536', winner: 'player1' }),
        mkMatch({ matchKey: '871486', player1Name: 'Janice Tjen', player1Key: '60341', player2Name: 'Darja Vidmanova', player2Key: '61710', winner: 'player1' }),
        mkMatch({ matchKey: '871459', player1Name: 'Taylor Townsend', player1Key: '13621', player2Name: 'Tatjana Maria', player2Key: '4110', winner: 'player1' }),
    ];
    const r16 = [
        mkMatch({ matchKey: '871470', player1Name: 'Magdalena Frech', player1Key: '17155', player2Name: 'Caroline Dolehide', player2Key: '28585', winner: 'player1' }),
        mkMatch({ matchKey: '871471', player1Name: 'Liudmila Samsonova', player1Key: '24368', player2Name: 'Kayla Day', player2Key: '30510', winner: 'player1' }),
        mkMatch({ matchKey: '871475', player1Name: 'Cristina Bucsa', player1Key: '24344', player2Name: 'Panna Udvardy', player2Key: '43866', winner: 'player1' }),
        mkMatch({ matchKey: '871477', player1Name: 'Sara Bejlek', player1Key: '71163', player2Name: 'Alycia Parks', player2Key: '45540', winner: 'player1' }),
        mkMatch({ matchKey: '871479', player1Name: 'Iva Jovic', player1Key: '80381', player2Name: 'Zeynep Sonmez', player2Key: '49991', winner: 'player1' }),
        mkMatch({ matchKey: '871480', player1Name: 'Peyton Stearns', player1Key: '53793', player2Name: 'Diane Parry', player2Key: '51151', winner: 'player1' }),
        mkMatch({ matchKey: '871484', player1Name: 'Sloane Stephens', player1Key: '10033', player2Name: 'Janice Tjen', player2Key: '60341', winner: 'player1' }),
    ];
    const qf = [
        mkMatch({ matchKey: '871467', player1Name: 'Iva Jovic', player1Key: '80381', player2Name: 'Magdalena Frech', player2Key: '17155', winner: 'player1' }),
        mkMatch({ matchKey: '871478', player1Name: 'Liudmila Samsonova', player1Key: '24368', player2Name: 'Marta Kostyuk', player2Key: '47742', winner: 'player1' }),
        mkMatch({ matchKey: '871490', player1Name: 'Cristina Bucsa', player1Key: '24344', player2Name: 'Sara Bejlek', player2Key: '71163', winner: 'player1' }),
        mkMatch({ matchKey: '2098410', player1Name: 'Peyton Stearns', player1Key: '53793', player2Name: 'Sloane Stephens', player2Key: '10033', winner: 'player1' }),
    ];
    const sf = [
        mkMatch({ matchKey: '25411875', player1Name: 'Iva Jovic', player1Key: '80381', player2Name: 'Cristina Bucsa', player2Key: '24344', winner: 'player1' }),
        mkMatch({ matchKey: '29093121', player1Name: 'Peyton Stearns', player1Key: '53793', player2Name: 'Liudmila Samsonova', player2Key: '24368', winner: 'player1' }),
    ];
    const fin = [
        mkMatch({ matchKey: '56089735', player1Name: 'Iva Jovic', player1Key: '80381', player2Name: 'Peyton Stearns', player2Key: '53793', winner: 'player1' }),
    ];
    return [
        { round: 'Final', order: 1, matches: fin },
        { round: 'Semi-finals', order: 2, matches: sf },
        { round: 'Quarter-finals', order: 3, matches: qf },
        { round: 'Round of 16', order: 4, matches: r16 },
        { round: 'Round of 32', order: 5, matches: r32 },
    ];
}

describe('getBracketSlots — Guadalajara 2026 WTA', () => {
    it('matches lettersOnly includes on the live tournament name', () => {
        const pairs = getBracketSlots('Guadalajara Open Akron - Guadalajara', 2026, 'WTA');
        expect(pairs).toBeTruthy();
        expect(pairs).toHaveLength(16);
        expect(pairs[0]).toEqual(['Kostyuk', 'BYE']);
        expect(pairs[1]).toEqual(['Maria', 'Townsend']);
        expect(pairs[15]).toEqual(['BYE', 'Jovic']);
        expect(pairs[11]).toEqual(['BYE', 'Bejlek']);
        expect(pairs[10]).toEqual(['Parks', 'Lepchenko']);
    });

    it('does not match ATP or the wrong year', () => {
        expect(getBracketSlots('Guadalajara Open Akron - Guadalajara', 2026, 'ATP')).toBeNull();
        expect(getBracketSlots('Guadalajara Open Akron - Guadalajara', 2025, 'WTA')).toBeNull();
    });
});

describe('assignSlotOrder — Guadalajara override', () => {
    it('places first-round in official order and fills printed byes only', () => {
        const rounds = assignSlotOrder(guadalajaraRaw(), 'WTA', 'Guadalajara Open Akron - Guadalajara');
        const r32 = rounds.find(r => /32/i.test(r.round)).matches;
        expect(r32).toHaveLength(16);
        expect(r32[0].player1Name.toLowerCase()).toContain('kostyuk');
        expect(r32[0].player2Name).toBe('BYE');
        expect(r32[0].isBye).toBe(true);
        expect(r32[0].winner).toBe('player1');
        expect(hasPair(r32[1], 'Maria', 'Townsend')).toBe(true);
        expect(hasPair(r32[2], 'Kalieva', 'Day')).toBe(true);
        expect(hasPair(r32[3], 'Jacquemot', 'Samsonova')).toBe(true);
        expect(r32[4].player1Name.toLowerCase()).toContain('parry');
        expect(r32[4].player2Name).toBe('BYE');
        expect(hasPair(r32[5], 'Stearns', 'Arango')).toBe(true);
        expect(hasPair(r32[6], 'Monnet', 'Stephens')).toBe(true);
        expect(hasPair(r32[7], 'Vidmanova', 'Tjen')).toBe(true);
        expect(hasPair(r32[8], 'Bucsa', 'Andreescu')).toBe(true);
        expect(hasPair(r32[9], 'Udvardy', 'Boisson')).toBe(true);
        expect(hasPair(r32[10], 'Parks', 'Lepchenko')).toBe(true);
        expect(r32[11].player2Name.toLowerCase()).toContain('bejlek');
        expect(r32[11].player1Name).toBe('BYE');
        expect(hasPair(r32[12], 'Frech', 'Hibino')).toBe(true);
        expect(hasPair(r32[13], 'Zarazua', 'Dolehide')).toBe(true);
        expect(hasPair(r32[14], 'Sonmez', 'Shymanovich')).toBe(true);
        expect(r32[15].player2Name.toLowerCase()).toContain('jovic');
        expect(r32[15].player1Name).toBe('BYE');
        expect(r32.every(m => m.slotIndex != null)).toBe(true);
        expect(rounds[0].slotOrderVerified).toBe(true);
    });

    it('does not invent player names on incomplete slots', () => {
        const rounds = assignSlotOrder(guadalajaraRaw(), 'WTA', 'Guadalajara Open Akron - Guadalajara');
        const invented = [];
        for (const r of rounds) {
            for (const m of r.matches) {
                for (const name of names(m)) {
                    if (!name) invented.push(`empty in ${r.round}`);
                    // TBD is only legal on an override TBD slot (none here).
                    if (/^tbd$/i.test(name) && r.round !== 'Round of 32') invented.push(name);
                }
            }
        }
        expect(invented).toEqual([]);
        const r32 = rounds.find(r => /32/i.test(r.round)).matches;
        const byeSlots = r32.filter(m => isByeNameSafe(m.player1Name) || isByeNameSafe(m.player2Name));
        expect(byeSlots).toHaveLength(4);
    });

    it('R16 count is 8 with Kostyuk/Townsend path; adjacent-slot R16→QF is 4/4', () => {
        const rounds = assignSlotOrder(guadalajaraRaw(), 'WTA', 'Guadalajara Open Akron - Guadalajara');
        const r16 = rounds.find(r => /16/i.test(r.round)).matches;
        const qf = rounds.find(r => /quarter/i.test(r.round)).matches;
        expect(r16).toHaveLength(8);
        expect(r16.some(m => hasPair(m, 'Kostyuk', 'Townsend'))).toBe(true);
        expect(r16[0].player1Name.toLowerCase()).toMatch(/kostyuk|townsend/);
        expect(r16[0].player2Name.toLowerCase()).toMatch(/kostyuk|townsend/);
        // Frech (R32 slot 12) and Jovic (R32 slot 15) meet in QF — their R16
        // matches must be adjacent slots 6 and 7.
        const frechR16 = r16.findIndex(m => hasPair(m, 'Frech', 'Dolehide'));
        const jovicR16 = r16.findIndex(m => names(m).some(n => /jovic/i.test(n)));
        expect(Math.min(frechR16, jovicR16)).toBe(6);
        expect(Math.max(frechR16, jovicR16)).toBe(7);
        expect(qf.some(m => hasPair(m, 'Jovic', 'Frech'))).toBe(true);
        expect(adjacentOk(r16, qf)).toBe(4);
    });

    it('copies Kostyuk\'s live player key onto the synthetic bye', () => {
        const rounds = assignSlotOrder(guadalajaraRaw(), 'WTA', 'Guadalajara Open Akron - Guadalajara');
        const r32 = rounds.find(r => /32/i.test(r.round)).matches;
        expect(r32[0].player1Key).toBe('47742');
    });
});

function isByeNameSafe(s) { return /^bye$/i.test((s || '').trim()); }

describe('assignSlotOrder — no override (matchKey is not order)', () => {
    // 16-player draw. First-round feed order is official-ish A..H; matchKeys
    // would sort H first. QF matchKeys are reversed vs parent slots.
    function unverifiedDraw() {
        const first = [
            mkMatch({ matchKey: '99', player1Name: 'A', player1Key: 'a', player2Name: 'A2', player2Key: 'a2', winner: 'player1' }),
            mkMatch({ matchKey: '10', player1Name: 'B', player1Key: 'b', player2Name: 'B2', player2Key: 'b2', winner: 'player1' }),
            mkMatch({ matchKey: '50', player1Name: 'C', player1Key: 'c', player2Name: 'C2', player2Key: 'c2', winner: 'player1' }),
            mkMatch({ matchKey: '20', player1Name: 'D', player1Key: 'd', player2Name: 'D2', player2Key: 'd2', winner: 'player1' }),
            mkMatch({ matchKey: '80', player1Name: 'E', player1Key: 'e', player2Name: 'E2', player2Key: 'e2', winner: 'player1' }),
            mkMatch({ matchKey: '15', player1Name: 'F', player1Key: 'f', player2Name: 'F2', player2Key: 'f2', winner: 'player1' }),
            mkMatch({ matchKey: '70', player1Name: 'G', player1Key: 'g', player2Name: 'G2', player2Key: 'g2', winner: 'player1' }),
            mkMatch({ matchKey: '5',  player1Name: 'H', player1Key: 'h', player2Name: 'H2', player2Key: 'h2', winner: 'player1' }),
        ];
        const qf = [
            mkMatch({ matchKey: '1', player1Name: 'G', player1Key: 'g', player2Name: 'H', player2Key: 'h', winner: 'player1' }),
            mkMatch({ matchKey: '2', player1Name: 'C', player1Key: 'c', player2Name: 'D', player2Key: 'd', winner: 'player1' }),
            mkMatch({ matchKey: '3', player1Name: 'E', player1Key: 'e', player2Name: 'F', player2Key: 'f', winner: 'player1' }),
            mkMatch({ matchKey: '4', player1Name: 'A', player1Key: 'a', player2Name: 'B', player2Key: 'b', winner: 'player1' }),
        ];
        return [
            { round: 'Quarter-finals', order: 3, matches: qf },
            { round: 'Round of 16', order: 4, matches: first },
        ];
    }

    it('keeps first-round feed order (does not sort by matchKey)', () => {
        const rounds = assignSlotOrder(unverifiedDraw(), 'WTA', 'Hypothetical Open');
        const first = rounds.find(r => /16/i.test(r.round)).matches;
        expect(first.map(m => m.player1Name).join('')).toBe('ABCDEFGH');
        expect(first[0].matchKey).toBe('99');
        expect(rounds[0].slotOrderVerified).toBe(false);
    });

    it('places QF from parent links so adjacent-slot R16→QF is 4/4', () => {
        const rounds = assignSlotOrder(unverifiedDraw(), 'WTA', 'Hypothetical Open');
        const r16 = rounds.find(r => /16/i.test(r.round)).matches;
        const qf = rounds.find(r => /quarter/i.test(r.round)).matches;
        expect(qf.map(m => m.player1Name).join('')).toBe('ACEG');
        expect(adjacentOk(r16, qf)).toBe(4);
    });
});
