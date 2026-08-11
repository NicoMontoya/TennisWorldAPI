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

const BRACKET_SLOTS = {"washington|2026|ATP": [["De Minaur", "Tsitsipas"], ["Giron", "Hewitt"], ["Nakashima", "Etcheverry"], ["Svajda", "Mensik"], ["Fritz", "Bergs"], ["Majchrzak", "Paul"], ["Michelsen", "Draper"], ["Mannarino", "Tien"], ["Fils", "Jodar"], ["Nishikori", "Shang"], ["Vukic", "Svajda"], ["Arnaldi", "Musetti"], ["Tiafoe", "Atmane"], ["Tabilo", "Griekspoor"], ["Humbert", "Martin"], ["Damm", "Shelton"]], "wimbledon|2026|ATP": [["Sinner", "Kecmanovic"], ["Borges", "Boyer"], ["Vukic", "Brooksby"], ["Nava", "Buse"], ["Jodar", "Gill"], ["Shapovalov", "Carreno Busta"], ["Mochizuki", "Basing"], ["Quinn", "Darderi"], ["Ruud", "Hurkacz"], ["Medjedovic", "Ofner"], ["Kwon", "Landaluce"], ["Muller", "Paul"], ["Nakashima", "Pinnington Jones"], ["Struff", "Baez"], ["Ugo Carabelli", "Merida"], ["Cilic", "Medvedev"], ["Auger-Aliassime", "Shevchenko"], ["Walton", "Prizmic"], ["Vallejo", "Mejia"], ["Zheng", "Norrie"], ["Davidovich Fokina", "Cerundolo"], ["Tirante", "Marozsan"], ["Van Assche", "Fucsovics"], ["Svrcina", "Tien"], ["Rublev", "Safiullin"], ["Kovacevic", "van de Zandschulp"], ["de Jong", "Hijikata"], ["Bautista Agut", "Fonseca"], ["Rinderknech", "Tarvet"], ["Trungelliti", "Damm"], ["Gaston", "Tsitsipas"], ["Wu", "Djokovic"], ["de Minaur", "Burruchaga"], ["Mannarino", "Droguet"], ["Llamas Ruiz", "Svajda"], ["Majchrzak", "Tabilo"], ["Khachanov", "Harris"], ["Hanfmann", "Mpetshi Perricard"], ["Griekspoor", "Duckworth"], ["Navone", "Cobolli"], ["Mensik", "Samuel"], ["Sweeny", "Dimitrov"], ["Wawrinka", "Berrettini"], ["Collignon", "Fils"], ["Humbert", "Bergs"], ["Shimabukuro", "Faria"], ["Dzumhur", "Fery"], ["Virtanen", "Shelton"], ["Fritz", "Lajovic"], ["Kypson", "McDonald"], ["Bonzi", "Diallo"], ["Sonego", "Etcheverry"], ["Tiafoe", "Atmane"], ["Kopriva", "Choinski"], ["Jacquet", "Gaubas"], ["Kokkinakis", "Bublik"], ["Lehecka", "Popyrin"], ["Molcan", "Altmaier"], ["Michelsen", "Fearnley"], ["Munar", "Cerundolo"], ["Arnaldi", "Halys"], ["Moutet", "Giron"], ["Royer", "Wendelken"], ["Blockx", "Zverev"]], "french open|2026|ATP": [["Sinner", "Tabur"], ["Fearnley", "Cerundolo J"], ["Landaluce", "Prado Angelo"], ["Kopriva", "Moutet"], ["Rinderknech", "Rodionov"], ["Fucsovics", "Berrettini"], ["Quinn", "Comesana"], ["Ofner", "Darderi"], ["Bublik", "Struff"], ["Faria", "Shapovalov"], ["Munar", "Hurkacz"], ["Spizzirri", "Tiafoe"], ["Griekspoor", "Arnaldi"], ["Muller", "Tsitsipas"], ["Collignon", "Vukic"], ["Merida", "Shelton"], ["Auger Aliassime", "Altmaier"], ["Baez", "Burruchaga"], ["Van Assche", "Kypson"], ["Bautista Agut", "Nakashima"], ["Norrie", "Vallejo"], ["Cilic", "Kouame"], ["Tabilo", "Majchrzak"], ["Faurel", "Vacherot"], ["Cobolli", "Pellegrino"], ["Wu", "Giron"], ["Diaz Acosta", "Zhang"], ["Garin", "Tien"], ["Cerundolo F", "Van De Zandschulp"], ["Gaston", "Monfils"], ["Popyrin", "Svajda"], ["Walton", "Medvedev"], ["De Minaur", "Samuel"], ["Blockx", "Wong"], ["Navone", "Brooksby"], ["Droguet", "Mensik"], ["Etcheverry", "Borges"], ["Kecmanovic", "Marozsan"], ["Nava", "Ugo Carabelli"], ["Buse", "Rublev"], ["Ruud", "Safiullin"], ["Medjedovic", "Hanfmann"], ["Sonego", "Herbert"], ["Hijikata", "Paul"], ["Fonseca", "Pavlovic"], ["Zheng", "Prizmic"], ["Dellien", "Royer"], ["Mpetshi Perricard", "Djokovic"], ["Fritz", "Basavareddy"], ["Shevchenko", "Michelsen"], ["Duckworth", "Diallo"], ["Kovacevic", "Jodar"], ["Davidovich Fokina", "Dzumhur"], ["Llamas Ruiz", "Tirante"], ["Kokkinakis", "Atmane"], ["Carreno Busta", "Lehecka"], ["Khachanov", "Gea"], ["Jacquet", "Trungelliti"], ["Cina", "Opelka"], ["Wawrinka", "De Jong"], ["Humbert", "Mannarino"], ["Halys", "Bellucci"], ["Machac", "Bergs"], ["Bonzi", "Zverev"]], "roland garros|2026|ATP": [["Sinner", "Tabur"], ["Fearnley", "Cerundolo J"], ["Landaluce", "Prado Angelo"], ["Kopriva", "Moutet"], ["Rinderknech", "Rodionov"], ["Fucsovics", "Berrettini"], ["Quinn", "Comesana"], ["Ofner", "Darderi"], ["Bublik", "Struff"], ["Faria", "Shapovalov"], ["Munar", "Hurkacz"], ["Spizzirri", "Tiafoe"], ["Griekspoor", "Arnaldi"], ["Muller", "Tsitsipas"], ["Collignon", "Vukic"], ["Merida", "Shelton"], ["Auger Aliassime", "Altmaier"], ["Baez", "Burruchaga"], ["Van Assche", "Kypson"], ["Bautista Agut", "Nakashima"], ["Norrie", "Vallejo"], ["Cilic", "Kouame"], ["Tabilo", "Majchrzak"], ["Faurel", "Vacherot"], ["Cobolli", "Pellegrino"], ["Wu", "Giron"], ["Diaz Acosta", "Zhang"], ["Garin", "Tien"], ["Cerundolo F", "Van De Zandschulp"], ["Gaston", "Monfils"], ["Popyrin", "Svajda"], ["Walton", "Medvedev"], ["De Minaur", "Samuel"], ["Blockx", "Wong"], ["Navone", "Brooksby"], ["Droguet", "Mensik"], ["Etcheverry", "Borges"], ["Kecmanovic", "Marozsan"], ["Nava", "Ugo Carabelli"], ["Buse", "Rublev"], ["Ruud", "Safiullin"], ["Medjedovic", "Hanfmann"], ["Sonego", "Herbert"], ["Hijikata", "Paul"], ["Fonseca", "Pavlovic"], ["Zheng", "Prizmic"], ["Dellien", "Royer"], ["Mpetshi Perricard", "Djokovic"], ["Fritz", "Basavareddy"], ["Shevchenko", "Michelsen"], ["Duckworth", "Diallo"], ["Kovacevic", "Jodar"], ["Davidovich Fokina", "Dzumhur"], ["Llamas Ruiz", "Tirante"], ["Kokkinakis", "Atmane"], ["Carreno Busta", "Lehecka"], ["Khachanov", "Gea"], ["Jacquet", "Trungelliti"], ["Cina", "Opelka"], ["Wawrinka", "De Jong"], ["Humbert", "Mannarino"], ["Halys", "Bellucci"], ["Machac", "Bergs"], ["Bonzi", "Zverev"]]};

import { relabelByDepth, expandByes } from './bracketStructure.js';

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

// Normalize round names, order, and roundId for a standard single-elimination
// draw — for EVERY tournament, captured or not. Upstream tags roundIds
// inconsistently for non-128 draws (a 32-draw's R32 arrives as roundId 4 as if it
// were R128), and the UI lays out bracket columns via roundId→depth. Left raw,
// small draws render into R128/R64 columns, phantom-empty columns appear, and
// SF/Final fall off the end ("breaks down at the semis"). Re-stamping each round
// to the canonical roundId for its true depth fixes both labels and column layout.
//
// Draw size D: from the override when present (exact, bye-aware); otherwise
// derived from the first round's match count (next power of two ≥ 2·M). Anchored
// at the FIRST round (always present, even mid-tournament) so depths are correct
// before the Final exists. Idempotent for 128-draws (already canonical). Skips
// non-standard structures (round-robin / bronze play-off).
function normalizeRoundStructure(rounds, pairs) {
    // Depth-from-final labeling recovered from the true leaf count (bye signature),
    // not the upstream roundId. See src/bracketStructure.js for the derivation.
    // An override pins the exact draw size (pairs are the first round → 2·pairs
    // players... but a 96-draw override would carry only its 32 first-round pairs,
    // so pass the hint only when it plausibly equals the full draw (128 Slams).
    const hint = pairs ? pairs.length * 2 : undefined;
    const leaves = relabelByDepth(rounds, hint && hint >= 64 ? hint : undefined);
    // Full fidelity for bye draws (Masters 96, 48, 56…): reconstruct the play-in
    // round to full width with explicit seed byes, so the client renders the
    // complete 128-leaf tree instead of a compacted view that drops a round.
    expandByes(rounds, leaves);
}

// Build a synthetic "Not Started" first-round match from an override pair, for a
// slot the upstream feed hasn't published yet (e.g. an unfinished qualifier slot
// pre-tournament). Cloned from a real first-round match so the shape the UI
// renderer and pick model expect is preserved; only the player fields differ.
// No player keys — advancement/picks stay TBD until the real match arrives.
function synthFirstRoundMatch(pair, template, slot) {
    const [p1, p2] = pair;
    return {
        ...template,
        matchKey:    `syn-${slot}`,
        player1Name: p1,
        player1Key:  '',
        player2Name: p2,
        player2Key:  '',
        winner:      null,
        setScores:   [],
        status:      'Not Started',
        isLive:      false,
        date:        null,
        player1Rank: null,
        player2Rank: null,
        player1Seed: null,
        player2Seed: null,
        synthetic:   true,
    };
}

/**
 * assignSlotOrder(rounds, tour, tournamentName):
 * sorts each round's matches and stamps `slotIndex` on every match.
 *
 * When an official override exists for the tournament, the first round is
 * rebuilt to the FULL bracket: each real match is placed at its true bracket
 * slot (its index in the override), and any slot the upstream feed hasn't
 * published yet is filled with a synthetic "Not Started" match from the
 * override. This makes the complete draw — both halves — render at true slot
 * positions before/at tournament start, instead of a compacted partial draw.
 * It also relabels the first round from the override's size (pairs*2), fixing
 * the roundId-based mislabel for non-128 draws.
 *
 * Without an override, behaviour is unchanged: matchKey order, compacted slots.
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
    if (pairs && first.matches.length) {
        // Place each real match at its true bracket slot; synthesize the rest.
        const template = first.matches[0];
        const filled   = new Array(pairs.length).fill(null);
        const claimed  = new Set();

        for (const m of first.matches) {
            const idx = findPairIndex(pairs, m.player1Name, m.player2Name);
            if (idx >= 0 && !filled[idx]) { filled[idx] = m; claimed.add(m); }
        }
        for (let i = 0; i < filled.length; i++) {
            if (!filled[i]) filled[i] = synthFirstRoundMatch(pairs[i], template, i);
        }
        // Real matches that didn't map (override drift / late change) are kept,
        // appended after the known slots rather than silently dropped.
        const unmapped = first.matches.filter(m => !claimed.has(m));
        first.matches = filled.concat(unmapped);
    }

    // Canonical round names / order / roundId for EVERY tournament (captured or
    // not) — fixes labels and the renderer's column layout at the source.
    normalizeRoundStructure(rounds, pairs);

    for (const r of rounds) {
        r.matches.forEach((m, i) => { m.slotIndex = i; });
    }
    return rounds;
}
