// ===================================
// TennisWorld — Official bracket slot orders (server-authoritative)
// ===================================
// Ported from TennisWorldUI/bracketSlots.js (API is authoritative; keep the UI
// copy in sync when that file still ships). The draws route emits matches in
// OFFICIAL bracket order with an explicit per-round `slotIndex` — the single
// slot authority every consumer (DrawBracket, RadialBracket, BracketPicks,
// bracketScoring) sorts by. matchKey is an opaque fixture id, NOT bracket
// order: sorting by it silently scrambles any draw without an override
// (WTA 500s). Unverified draws keep first-round feed order and place later
// rounds via winner→parent links so adjacent slots still meet.

const BRACKET_SLOTS = {"us open|2026|ATP": [["Zverev", "Sonego"], ["Halys", "Diaz Acosta"], ["Dimitrov", "Popyrin"], ["Hanfmann", "Tabilo"], ["Darderi", "Wendelken"], ["Svrcina", "Royer"], ["Sweeny", "Moutet"], ["Fery", "Musetti"], ["Jodar", "Kokkinakis"], ["Marozsan", "Zheng"], ["Svajda", "Altmaier"], ["Cerundolo", "Ruud"], ["Bergs", "Taberner"], ["de Jong", "Passaro"], ["Choinski", "van de Zandschulp"], ["Guerrieri", "de Minaur"], ["Auger-Aliassime", "Hijikata"], ["Burruchaga", "Khachanov"], ["Molcan", "Bonzi"], ["Giron", "Buse"], ["Mensik", "Mochizuki"], ["Rodionov", "Mpetshi Perricard"], ["Vallejo", "Monfils"], ["Borges", "Tien"], ["Fritz", "Dar Blanch"], ["Bellucci", "Piros"], ["Ugo Carabelli", "Struff"], ["Misolic", "Cerundolo"], ["Blockx", "Barrios Vera"], ["Shang", "Trungelliti"], ["Basavareddy", "Schoolkate"], ["Comesana", "Cobolli"], ["Medvedev", "Gaston"], ["Gorzny", "Collignon"], ["Munar", "Atmane"], ["Shimabukuro", "Rinderknech"], ["Vacherot", "Kovacevic"], ["Majchrzak", "Medjedovic"], ["Vukic", "Sakamoto"], ["Damm", "Tiafoe"], ["Nakashima", "Baez"], ["Michelsen", "Cina"], ["Merida", "Fucsovics"], ["Cilic", "Rublev"], ["Etcheverry", "Kopriva"], ["Landaluce", "Fearnley"], ["Berrettini", "Wawrinka"], ["Navone", "Djokovic"], ["Shelton", "Griekspoor"], ["Dzumhur", "Hurkacz"], ["Kecmanovic", "Shapovalov"], ["Van Assche", "Norrie"], ["Lehecka", "Carreno Busta"], ["Samuel", "Machac"], ["Harris", "Kennedy"], ["Tsitsipas", "Fils"], ["Bublik", "Wolf"], ["Tirante", "Mannarino"], ["Prizmic", "Shevchenko"], ["Wong", "Paul"], ["Arnaldi", "Duckworth"], ["Wu", "Walton"], ["Faria", "Brooksby"], ["Safiullin", "Alcaraz"]], "washington|2026|ATP": [["De Minaur", "Tsitsipas"], ["Giron", "Hewitt"], ["Nakashima", "Etcheverry"], ["Svajda", "Mensik"], ["Fritz", "Bergs"], ["Majchrzak", "Paul"], ["Michelsen", "Draper"], ["Mannarino", "Tien"], ["Fils", "Jodar"], ["Nishikori", "Shang"], ["Vukic", "Svajda"], ["Arnaldi", "Musetti"], ["Tiafoe", "Atmane"], ["Tabilo", "Griekspoor"], ["Humbert", "Martin"], ["Damm", "Shelton"]], "wimbledon|2026|ATP": [["Sinner", "Kecmanovic"], ["Borges", "Boyer"], ["Vukic", "Brooksby"], ["Nava", "Buse"], ["Jodar", "Gill"], ["Shapovalov", "Carreno Busta"], ["Mochizuki", "Basing"], ["Quinn", "Darderi"], ["Ruud", "Hurkacz"], ["Medjedovic", "Ofner"], ["Kwon", "Landaluce"], ["Muller", "Paul"], ["Nakashima", "Pinnington Jones"], ["Struff", "Baez"], ["Ugo Carabelli", "Merida"], ["Cilic", "Medvedev"], ["Auger-Aliassime", "Shevchenko"], ["Walton", "Prizmic"], ["Vallejo", "Mejia"], ["Zheng", "Norrie"], ["Davidovich Fokina", "Cerundolo"], ["Tirante", "Marozsan"], ["Van Assche", "Fucsovics"], ["Svrcina", "Tien"], ["Rublev", "Safiullin"], ["Kovacevic", "van de Zandschulp"], ["de Jong", "Hijikata"], ["Bautista Agut", "Fonseca"], ["Rinderknech", "Tarvet"], ["Trungelliti", "Damm"], ["Gaston", "Tsitsipas"], ["Wu", "Djokovic"], ["de Minaur", "Burruchaga"], ["Mannarino", "Droguet"], ["Llamas Ruiz", "Svajda"], ["Majchrzak", "Tabilo"], ["Khachanov", "Harris"], ["Hanfmann", "Mpetshi Perricard"], ["Griekspoor", "Duckworth"], ["Navone", "Cobolli"], ["Mensik", "Samuel"], ["Sweeny", "Dimitrov"], ["Wawrinka", "Berrettini"], ["Collignon", "Fils"], ["Humbert", "Bergs"], ["Shimabukuro", "Faria"], ["Dzumhur", "Fery"], ["Virtanen", "Shelton"], ["Fritz", "Lajovic"], ["Kypson", "McDonald"], ["Bonzi", "Diallo"], ["Sonego", "Etcheverry"], ["Tiafoe", "Atmane"], ["Kopriva", "Choinski"], ["Jacquet", "Gaubas"], ["Kokkinakis", "Bublik"], ["Lehecka", "Popyrin"], ["Molcan", "Altmaier"], ["Michelsen", "Fearnley"], ["Munar", "Cerundolo"], ["Arnaldi", "Halys"], ["Moutet", "Giron"], ["Royer", "Wendelken"], ["Blockx", "Zverev"]], "french open|2026|ATP": [["Sinner", "Tabur"], ["Fearnley", "Cerundolo J"], ["Landaluce", "Prado Angelo"], ["Kopriva", "Moutet"], ["Rinderknech", "Rodionov"], ["Fucsovics", "Berrettini"], ["Quinn", "Comesana"], ["Ofner", "Darderi"], ["Bublik", "Struff"], ["Faria", "Shapovalov"], ["Munar", "Hurkacz"], ["Spizzirri", "Tiafoe"], ["Griekspoor", "Arnaldi"], ["Muller", "Tsitsipas"], ["Collignon", "Vukic"], ["Merida", "Shelton"], ["Auger Aliassime", "Altmaier"], ["Baez", "Burruchaga"], ["Van Assche", "Kypson"], ["Bautista Agut", "Nakashima"], ["Norrie", "Vallejo"], ["Cilic", "Kouame"], ["Tabilo", "Majchrzak"], ["Faurel", "Vacherot"], ["Cobolli", "Pellegrino"], ["Wu", "Giron"], ["Diaz Acosta", "Zhang"], ["Garin", "Tien"], ["Cerundolo F", "Van De Zandschulp"], ["Gaston", "Monfils"], ["Popyrin", "Svajda"], ["Walton", "Medvedev"], ["De Minaur", "Samuel"], ["Blockx", "Wong"], ["Navone", "Brooksby"], ["Droguet", "Mensik"], ["Etcheverry", "Borges"], ["Kecmanovic", "Marozsan"], ["Nava", "Ugo Carabelli"], ["Buse", "Rublev"], ["Ruud", "Safiullin"], ["Medjedovic", "Hanfmann"], ["Sonego", "Herbert"], ["Hijikata", "Paul"], ["Fonseca", "Pavlovic"], ["Zheng", "Prizmic"], ["Dellien", "Royer"], ["Mpetshi Perricard", "Djokovic"], ["Fritz", "Basavareddy"], ["Shevchenko", "Michelsen"], ["Duckworth", "Diallo"], ["Kovacevic", "Jodar"], ["Davidovich Fokina", "Dzumhur"], ["Llamas Ruiz", "Tirante"], ["Kokkinakis", "Atmane"], ["Carreno Busta", "Lehecka"], ["Khachanov", "Gea"], ["Jacquet", "Trungelliti"], ["Cina", "Opelka"], ["Wawrinka", "De Jong"], ["Humbert", "Mannarino"], ["Halys", "Bellucci"], ["Machac", "Bergs"], ["Bonzi", "Zverev"]], "roland garros|2026|ATP": [["Sinner", "Tabur"], ["Fearnley", "Cerundolo J"], ["Landaluce", "Prado Angelo"], ["Kopriva", "Moutet"], ["Rinderknech", "Rodionov"], ["Fucsovics", "Berrettini"], ["Quinn", "Comesana"], ["Ofner", "Darderi"], ["Bublik", "Struff"], ["Faria", "Shapovalov"], ["Munar", "Hurkacz"], ["Spizzirri", "Tiafoe"], ["Griekspoor", "Arnaldi"], ["Muller", "Tsitsipas"], ["Collignon", "Vukic"], ["Merida", "Shelton"], ["Auger Aliassime", "Altmaier"], ["Baez", "Burruchaga"], ["Van Assche", "Kypson"], ["Bautista Agut", "Nakashima"], ["Norrie", "Vallejo"], ["Cilic", "Kouame"], ["Tabilo", "Majchrzak"], ["Faurel", "Vacherot"], ["Cobolli", "Pellegrino"], ["Wu", "Giron"], ["Diaz Acosta", "Zhang"], ["Garin", "Tien"], ["Cerundolo F", "Van De Zandschulp"], ["Gaston", "Monfils"], ["Popyrin", "Svajda"], ["Walton", "Medvedev"], ["De Minaur", "Samuel"], ["Blockx", "Wong"], ["Navone", "Brooksby"], ["Droguet", "Mensik"], ["Etcheverry", "Borges"], ["Kecmanovic", "Marozsan"], ["Nava", "Ugo Carabelli"], ["Buse", "Rublev"], ["Ruud", "Safiullin"], ["Medjedovic", "Hanfmann"], ["Sonego", "Herbert"], ["Hijikata", "Paul"], ["Fonseca", "Pavlovic"], ["Zheng", "Prizmic"], ["Dellien", "Royer"], ["Mpetshi Perricard", "Djokovic"], ["Fritz", "Basavareddy"], ["Shevchenko", "Michelsen"], ["Duckworth", "Diallo"], ["Kovacevic", "Jodar"], ["Davidovich Fokina", "Dzumhur"], ["Llamas Ruiz", "Tirante"], ["Kokkinakis", "Atmane"], ["Carreno Busta", "Lehecka"], ["Khachanov", "Gea"], ["Jacquet", "Trungelliti"], ["Cina", "Opelka"], ["Wawrinka", "De Jong"], ["Humbert", "Mannarino"], ["Halys", "Bellucci"], ["Machac", "Bergs"], ["Bonzi", "Zverev"]]};

// Guadalajara Open Akron 2026 WTA — 28-draw (4 byes). Official top→bottom
// order from wtatennis.com/tournaments/2075/guadalajara-500/2026/draws.
// Tokens are live /api/draws?tournamentKey=16745&season=2026&tour=WTA
// first-round surnames so findPairIndex hits; BYE only on printed byes.
// Kostyuk's R32 bye is not in the feed (she appears first at R16 via WO).
BRACKET_SLOTS['guadalajara|2026|WTA'] = [
    ['Kostyuk', 'BYE'],
    ['Maria', 'Townsend'],
    ['Kalieva', 'Day'],
    ['Jacquemot', 'Samsonova'],
    ['Parry', 'BYE'],
    ['Stearns', 'Arango'],
    ['Monnet', 'Stephens'],
    ['Vidmanova', 'Tjen'],
    ['Bucsa', 'Andreescu'],
    ['Udvardy', 'Boisson'],
    ['Parks', 'Lepchenko'],
    ['BYE', 'Bejlek'],
    ['Frech', 'Hibino'],
    ['Zarazua', 'Dolehide'],
    ['Sonmez', 'Shymanovich'],
    ['BYE', 'Jovic'],
];

import { relabelByDepth, expandByes } from './bracketStructure.js';

const lettersOnly = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');

export function getBracketSlots(tournamentName, year, tour) {
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
function isByeName(s) { return /^bye$/i.test((s || '').trim()); }
function isTbdName(s) { return /^tbd$/i.test((s || '').trim()); }
function isRealKey(k) { return k != null && k !== '' && k !== 'null' && k !== 'undefined'; }

function synthFirstRoundMatch(pair, template, slot) {
    const [p1, p2] = pair;
    const p1Bye = isByeName(p1);
    const p2Bye = isByeName(p2);
    const isBye = p1Bye || p2Bye;
    // Auto-advance the non-BYE side (same contract as expandByes). TBD stays open.
    const winner = (isBye && !p1Bye && p2Bye) ? 'player1'
        : (isBye && p1Bye && !p2Bye) ? 'player2'
        : null;
    return {
        ...template,
        matchKey:    `syn-${slot}`,
        player1Name: p1,
        player1Key:  '',
        player2Name: p2,
        player2Key:  '',
        winner,
        setScores:   [],
        status:      winner ? 'Finished' : 'Not Started',
        isLive:      false,
        date:        template.date || null,
        player1Rank: null,
        player2Rank: null,
        player1Seed: null,
        player2Seed: null,
        synthetic:   true,
        isBye:       isBye || undefined,
    };
}

function winnerSideOf(m) {
    if (m.winner === 'player1') {
        return { key: m.player1Key, name: m.player1Name, seed: m.player1Seed, rank: m.player1Rank };
    }
    if (m.winner === 'player2') {
        return { key: m.player2Key, name: m.player2Name, seed: m.player2Seed, rank: m.player2Rank };
    }
    return null;
}

function laterContains(roundsAfter, key, name) {
    for (const r of roundsAfter) {
        for (const m of r.matches) {
            if (isRealKey(key) && (String(m.player1Key) === String(key) || String(m.player2Key) === String(key))) {
                return true;
            }
            if (name && !isByeName(name) && !isTbdName(name) &&
                (nameHits(m.player1Name, name) || nameHits(m.player2Name, name))) {
                return true;
            }
        }
    }
    return false;
}

function samePairing(m, a, b) {
    const hit = (name, who) => nameHits(name, who.name) || nameHits(who.name, name);
    return (hit(m.player1Name, a) && hit(m.player2Name, b)) ||
        (hit(m.player1Name, b) && hit(m.player2Name, a));
}

function indexPlayers(matches) {
    const byKey = new Map();
    const byName = new Map();
    matches.forEach((m, i) => {
        for (const side of ['player1', 'player2']) {
            const key = m[`${side}Key`];
            const raw = m[`${side}Name`];
            const name = norm(raw);
            if (isRealKey(key)) byKey.set(String(key), i);
            if (name && name !== 'bye' && name !== 'tbd') byName.set(name, i);
        }
    });
    return { byKey, byName };
}

function lookupSlot(m, side, index) {
    const key = m[`${side}Key`];
    if (isRealKey(key) && index.byKey.has(String(key))) return index.byKey.get(String(key));
    const name = norm(m[`${side}Name`]);
    if (!name || name === 'bye' || name === 'tbd') return null;
    if (index.byName.has(name)) return index.byName.get(name);
    for (const [n, slot] of index.byName) {
        if (nameHits(n, name) || nameHits(name, n)) return slot;
    }
    return null;
}

function synthLaterMatch(template, slot, wA, wB, laterRounds) {
    let winner = null;
    const in1 = laterContains(laterRounds, wA.key, wA.name);
    const in2 = laterContains(laterRounds, wB.key, wB.name);
    if (in1 && !in2) winner = 'player1';
    else if (in2 && !in1) winner = 'player2';
    return {
        ...template,
        matchKey:    `syn-later-${template.roundId || 'r'}-${slot}`,
        player1Name: wA.name,
        player1Key:  isRealKey(wA.key) ? String(wA.key) : '',
        player1Seed: wA.seed ?? null,
        player1Rank: wA.rank ?? null,
        player2Name: wB.name,
        player2Key:  isRealKey(wB.key) ? String(wB.key) : '',
        player2Seed: wB.seed ?? null,
        player2Rank: wB.rank ?? null,
        winner,
        setScores:   [],
        status:      winner ? 'Finished' : 'Not Started',
        isLive:      false,
        synthetic:   true,
    };
}

// Copy player keys/seeds/ranks onto synthetic first-round slots from later
// appearances (e.g. Kostyuk's bye isn't in the feed; she first appears in QF).
function enrichSynthKeysFromLater(first, rounds) {
    const later = [];
    for (const r of rounds) {
        if (r === first) continue;
        for (const m of r.matches) {
            later.push({ key: m.player1Key, name: m.player1Name, seed: m.player1Seed, rank: m.player1Rank });
            later.push({ key: m.player2Key, name: m.player2Name, seed: m.player2Seed, rank: m.player2Rank });
        }
    }
    for (const m of first.matches) {
        if (!m.synthetic) continue;
        for (const side of ['player1', 'player2']) {
            const name = m[`${side}Name`];
            if (!name || isByeName(name) || isTbdName(name)) continue;
            const hit = later.find(p => isRealKey(p.key) && nameHits(p.name, name));
            if (hit) {
                m[`${side}Key`] = String(hit.key);
                if (m[`${side}Seed`] == null) m[`${side}Seed`] = hit.seed ?? null;
                if (m[`${side}Rank`] == null) m[`${side}Rank`] = hit.rank ?? null;
            }
        }
    }
}

/**
 * Place later-round matches at the slot implied by their previous-round
 * parents (winner of slots 2i, 2i+1 → slot i). matchKey is never consulted.
 * When both feeders have real-named winners and the next match is missing
 * from the feed (walkover), fill that hole from those winners — no invented
 * names. Unmapped real matches are appended, not dropped.
 */
function placeLaterFromParents(rounds) {
    const ordered = rounds.slice().sort((a, b) => b.order - a.order);
    if (ordered.length < 2) return;

    for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const curr = ordered[i];
        const index = indexPlayers(prev.matches);
        const width = Math.max(curr.matches.length, Math.floor(prev.matches.length / 2) || 0);
        if (!width) continue;

        const placed = new Array(width).fill(null);
        const unmatched = [];
        for (const m of curr.matches) {
            const s1 = lookupSlot(m, 'player1', index);
            const s2 = lookupSlot(m, 'player2', index);
            let slot = null;
            if (s1 != null && s2 != null && Math.floor(s1 / 2) === Math.floor(s2 / 2)) {
                slot = Math.floor(s1 / 2);
            } else if (s1 != null && s2 != null) {
                slot = Math.floor(Math.min(s1, s2) / 2);
            } else if (s1 != null) {
                slot = Math.floor(s1 / 2);
            } else if (s2 != null) {
                slot = Math.floor(s2 / 2);
            }
            if (slot != null && slot >= 0 && slot < width && !placed[slot]) placed[slot] = m;
            else unmatched.push(m);
        }

        const later = ordered.slice(i + 1);
        const template = curr.matches[0] || prev.matches[0];
        for (let s = 0; s < width; s++) {
            if (placed[s]) continue;
            const a = prev.matches[s * 2];
            const b = prev.matches[s * 2 + 1];
            if (!a || !b) continue;
            const wA = winnerSideOf(a);
            const wB = winnerSideOf(b);
            if (!wA?.name || !wB?.name) continue;
            if (isTbdName(wA.name) || isTbdName(wB.name)) continue;
            const hit = unmatched.findIndex(m => samePairing(m, wA, wB));
            if (hit >= 0) {
                placed[s] = unmatched.splice(hit, 1)[0];
                continue;
            }
            placed[s] = synthLaterMatch(template, s, wA, wB, later);
        }

        const out = [];
        for (let s = 0; s < width; s++) {
            if (placed[s]) out.push(placed[s]);
        }
        out.push(...unmatched);
        curr.matches = out;
    }
}

/**
 * assignSlotOrder(rounds, tour, tournamentName):
 * orders each round and stamps `slotIndex` on every match.
 *
 * When an official override exists, the first round is rebuilt to the FULL
 * bracket: each real match is placed at its printed slot, unpublished slots
 * are filled from the override (BYE/TBD only where the override says so),
 * and later rounds are laid out from winner→parent links.
 *
 * Without an override, matchKey is NOT treated as bracket order (it is an
 * opaque fixture id and silently scrambles WTA 500s). First-round stays in
 * feed order; later rounds are placed via parent links so adjacent slots
 * still meet. slotOrderVerified is false — slotIndex is tree-relative, not
 * the printed sheet.
 *
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

    // Do not sort by matchKey — it is not official bracket order.

    const pairs = getBracketSlots(tournamentName, year, tour);
    const verified = !!(pairs && first.matches.length);
    if (verified) {
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
        const unmapped = first.matches.filter(m => !claimed.has(m));
        first.matches = filled.concat(unmapped);
        enrichSynthKeysFromLater(first, rounds);
    }

    // Canonical round names / order / roundId for EVERY tournament (captured or
    // not) — fixes labels and the renderer's column layout at the source.
    normalizeRoundStructure(rounds, pairs);

    // Parent-link later rounds so QF/SF/F follow the first-round tree instead
    // of an independent matchKey sort.
    placeLaterFromParents(rounds);

    for (const r of rounds) {
        r.matches.forEach((m, i) => { m.slotIndex = i; });
        r.slotOrderVerified = verified;
    }
    return rounds;
}
