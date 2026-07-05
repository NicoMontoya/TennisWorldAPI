// ===================================
// TennisWorld — Official bracket slot orders (server-authoritative)
// ===================================
// Ported from TennisWorldUI/bracketSlots.js (keep entries in sync; add a new
// entry each Grand Slam draw day). The draws route uses this to emit matches
// in OFFICIAL bracket order with an explicit per-round `slotIndex` — the single
// slot authority every consumer (DrawBracket, RadialBracket, BracketPicks,
// bracketScoring) sorts by. Before this, the renderer and the pick model could
// disagree on first-round order (renderer applied the override, model sorted by
// matchKey), which broke winner advancement on override tournaments.

const BRACKET_SLOTS = {"wimbledon|2026|ATP": [["Sinner", "Kecmanovic"], ["Borges", "Boyer"], ["Vukic", "Brooksby"], ["Nava", "Buse"], ["Jodar", "Gill"], ["Shapovalov", "Carreno Busta"], ["Mochizuki", "Basing"], ["Quinn", "Darderi"], ["Ruud", "Hurkacz"], ["Medjedovic", "Ofner"], ["Kwon", "Landaluce"], ["Muller", "Paul"], ["Nakashima", "Pinnington Jones"], ["Struff", "Baez"], ["Ugo Carabelli", "Merida"], ["Cilic", "Medvedev"], ["Auger-Aliassime", "Shevchenko"], ["Walton", "Prizmic"], ["Vallejo", "Mejia"], ["Zheng", "Norrie"], ["Davidovich Fokina", "Cerundolo"], ["Tirante", "Marozsan"], ["Van Assche", "Fucsovics"], ["Svrcina", "Tien"], ["Rublev", "Safiullin"], ["Kovacevic", "van de Zandschulp"], ["de Jong", "Hijikata"], ["Bautista Agut", "Fonseca"], ["Rinderknech", "Tarvet"], ["Trungelliti", "Damm"], ["Gaston", "Tsitsipas"], ["Wu", "Djokovic"], ["de Minaur", "Burruchaga"], ["Mannarino", "Droguet"], ["Llamas Ruiz", "Svajda"], ["Majchrzak", "Tabilo"], ["Khachanov", "Harris"], ["Hanfmann", "Mpetshi Perricard"], ["Griekspoor", "Duckworth"], ["Navone", "Cobolli"], ["Mensik", "Samuel"], ["Sweeny", "Dimitrov"], ["Wawrinka", "Berrettini"], ["Collignon", "Fils"], ["Humbert", "Bergs"], ["Shimabukuro", "Faria"], ["Dzumhur", "Fery"], ["Virtanen", "Shelton"], ["Fritz", "Lajovic"], ["Kypson", "McDonald"], ["Bonzi", "Diallo"], ["Sonego", "Etcheverry"], ["Tiafoe", "Atmane"], ["Kopriva", "Choinski"], ["Jacquet", "Gaubas"], ["Kokkinakis", "Bublik"], ["Lehecka", "Popyrin"], ["Molcan", "Altmaier"], ["Michelsen", "Fearnley"], ["Munar", "Cerundolo"], ["Arnaldi", "Halys"], ["Moutet", "Giron"], ["Royer", "Wendelken"], ["Blockx", "Zverev"]], "french open|2026|ATP": [["Sinner", "Tabur"], ["Fearnley", "Cerundolo J"], ["Landaluce", "Prado Angelo"], ["Kopriva", "Moutet"], ["Rinderknech", "Rodionov"], ["Fucsovics", "Berrettini"], ["Quinn", "Comesana"], ["Ofner", "Darderi"], ["Bublik", "Struff"], ["Faria", "Shapovalov"], ["Munar", "Hurkacz"], ["Spizzirri", "Tiafoe"], ["Griekspoor", "Arnaldi"], ["Muller", "Tsitsipas"], ["Collignon", "Vukic"], ["Merida", "Shelton"], ["Auger Aliassime", "Altmaier"], ["Baez", "Burruchaga"], ["Van Assche", "Kypson"], ["Bautista Agut", "Nakashima"], ["Norrie", "Vallejo"], ["Cilic", "Kouame"], ["Tabilo", "Majchrzak"], ["Faurel", "Vacherot"], ["Cobolli", "Pellegrino"], ["Wu", "Giron"], ["Diaz Acosta", "Zhang"], ["Garin", "Tien"], ["Cerundolo F", "Van De Zandschulp"], ["Gaston", "Monfils"], ["Popyrin", "Svajda"], ["Walton", "Medvedev"], ["De Minaur", "Samuel"], ["Blockx", "Wong"], ["Navone", "Brooksby"], ["Droguet", "Mensik"], ["Etcheverry", "Borges"], ["Kecmanovic", "Marozsan"], ["Nava", "Ugo Carabelli"], ["Buse", "Rublev"], ["Ruud", "Safiullin"], ["Medjedovic", "Hanfmann"], ["Sonego", "Herbert"], ["Hijikata", "Paul"], ["Fonseca", "Pavlovic"], ["Zheng", "Prizmic"], ["Dellien", "Royer"], ["Mpetshi Perricard", "Djokovic"], ["Fritz", "Basavareddy"], ["Shevchenko", "Michelsen"], ["Duckworth", "Diallo"], ["Kovacevic", "Jodar"], ["Davidovich Fokina", "Dzumhur"], ["Llamas Ruiz", "Tirante"], ["Kokkinakis", "Atmane"], ["Carreno Busta", "Lehecka"], ["Khachanov", "Gea"], ["Jacquet", "Trungelliti"], ["Cina", "Opelka"], ["Wawrinka", "De Jong"], ["Humbert", "Mannarino"], ["Halys", "Bellucci"], ["Machac", "Bergs"], ["Bonzi", "Zverev"]], "roland garros|2026|ATP": [["Sinner", "Tabur"], ["Fearnley", "Cerundolo J"], ["Landaluce", "Prado Angelo"], ["Kopriva", "Moutet"], ["Rinderknech", "Rodionov"], ["Fucsovics", "Berrettini"], ["Quinn", "Comesana"], ["Ofner", "Darderi"], ["Bublik", "Struff"], ["Faria", "Shapovalov"], ["Munar", "Hurkacz"], ["Spizzirri", "Tiafoe"], ["Griekspoor", "Arnaldi"], ["Muller", "Tsitsipas"], ["Collignon", "Vukic"], ["Merida", "Shelton"], ["Auger Aliassime", "Altmaier"], ["Baez", "Burruchaga"], ["Van Assche", "Kypson"], ["Bautista Agut", "Nakashima"], ["Norrie", "Vallejo"], ["Cilic", "Kouame"], ["Tabilo", "Majchrzak"], ["Faurel", "Vacherot"], ["Cobolli", "Pellegrino"], ["Wu", "Giron"], ["Diaz Acosta", "Zhang"], ["Garin", "Tien"], ["Cerundolo F", "Van De Zandschulp"], ["Gaston", "Monfils"], ["Popyrin", "Svajda"], ["Walton", "Medvedev"], ["De Minaur", "Samuel"], ["Blockx", "Wong"], ["Navone", "Brooksby"], ["Droguet", "Mensik"], ["Etcheverry", "Borges"], ["Kecmanovic", "Marozsan"], ["Nava", "Ugo Carabelli"], ["Buse", "Rublev"], ["Ruud", "Safiullin"], ["Medjedovic", "Hanfmann"], ["Sonego", "Herbert"], ["Hijikata", "Paul"], ["Fonseca", "Pavlovic"], ["Zheng", "Prizmic"], ["Dellien", "Royer"], ["Mpetshi Perricard", "Djokovic"], ["Fritz", "Basavareddy"], ["Shevchenko", "Michelsen"], ["Duckworth", "Diallo"], ["Kovacevic", "Jodar"], ["Davidovich Fokina", "Dzumhur"], ["Llamas Ruiz", "Tirante"], ["Kokkinakis", "Atmane"], ["Carreno Busta", "Lehecka"], ["Khachanov", "Gea"], ["Jacquet", "Trungelliti"], ["Cina", "Opelka"], ["Wawrinka", "De Jong"], ["Humbert", "Mannarino"], ["Halys", "Bellucci"], ["Machac", "Bergs"], ["Bonzi", "Zverev"]]};

const lettersOnly = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');

function getBracketSlots(tournamentName, year, tour) {
    const name = lettersOnly(tournamentName);
    const yr = String(year || '');
    const t = (tour || '').toUpperCase();
    for (const [key, ps] of Object.entries(BRACKET_SLOTS)) {
        const [kName, kYear, kTour] = key.split('|');
        if (name.includes(lettersOnly(kName)) && yr === kYear && t === kTour) return ps;
    }
    return null;
}

function norm(s) {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function nameHits(apiName, slotKeyword) {
    const a = norm(apiName), k = norm(slotKeyword);
    return a.includes(k) || k.includes(a);
}

function findPairIndex(pairs, name1, name2) {
    for (let i = 0; i < pairs.length; i++) {
        const [p1, p2] = pairs[i];
        if ((nameHits(name1, p1) && nameHits(name2, p2)) ||
            (nameHits(name1, p2) && nameHits(name2, p1))) return i;
    }
    for (let i = 0; i < pairs.length; i++) {
        const [p1, p2] = pairs[i];
        if (nameHits(name1, p1) || nameHits(name1, p2) ||
            nameHits(name2, p1) || nameHits(name2, p2)) return i;
    }
    return -1;
}

/**
 * assignSlotOrder(rounds, tour, tournamentName):
 * sorts each round's matches (official override for the first round when we
 * have one, matchKey order otherwise) and stamps `slotIndex` on every match.
 * Mutates in place; returns rounds.
 */
export function assignSlotOrder(rounds, tour, tournamentName) {
    if (!rounds || !rounds.length) return rounds;

    // First (earliest) elimination round = highest `order` value.
    const first = rounds.reduce((a, b) => (b.order > a.order ? b : a), rounds[0]);

    // Tournament year from match dates (draws span one edition per key).
    let year = '';
    outer: for (const r of rounds) {
        for (const m of r.matches) {
            if (m.date) { year = String(m.date).slice(0, 4); break outer; }
        }
    }

    for (const r of rounds) {
        r.matches.sort((a, b) => Number(a.matchKey) - Number(b.matchKey));
    }

    const pairs = getBracketSlots(tournamentName, year, tour);
    if (pairs) {
        first.matches.sort((a, b) => {
            const pa = findPairIndex(pairs, a.player1Name, a.player2Name);
            const pb = findPairIndex(pairs, b.player1Name, b.player2Name);
            return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
        });
    }

    for (const r of rounds) {
        r.matches.forEach((m, i) => { m.slotIndex = i; });
    }
    return rounds;
}
