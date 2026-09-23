// ===================================
// TennisWorld — Official bracket slot orders (server-authoritative)
// ===================================
// Ported from TennisWorldUI/bracketSlots.js (API is authoritative; keep the UI
// copy in sync when that file still ships). The draws route emits matches with
// a per-round `slotIndex` — the single slot authority every consumer
// (DrawBracket, RadialBracket, BracketPicks, bracketScoring) sorts by.
//
// GENERAL PATH (ATP + WTA, past / live / future): matchKey is an opaque
// fixture id, never bracket order. Without an override we reconstruct a
// consistent binary tree from winner→parent / child links, walking BACKWARD
// from the latest round so adjacent slots meet at every level. Missing
// feeders (walkovers, unpublished byes) are filled only from real leftover
// winners or an honest BYE — no invented player names.
//
// OVERRIDES are emergency-only for live fires when the printed sheet must
// win (Guadalajara 2026 WTA). slotOrderVerified is true only then.

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
function leafCount(rounds, pairs) {
    // Depth-from-final labeling recovered from the true leaf count (bye signature),
    // not the upstream roundId. See src/bracketStructure.js for the derivation.
    // An override pins the exact draw size (pairs are the first round → 2·pairs
    // players... but a 96-draw override would carry only its 32 first-round pairs,
    // so pass the hint only when it plausibly equals the full draw (128 Slams).
    const hint = pairs ? pairs.length * 2 : undefined;
    return relabelByDepth(rounds, hint && hint >= 64 ? hint : undefined);
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

function allPlayersOf(matches) {
    const keys = new Set();
    const names = new Set();
    for (const m of matches || []) {
        for (const side of ['player1', 'player2']) {
            const key = m[`${side}Key`];
            const n = norm(m[`${side}Name`]);
            if (isRealKey(key)) keys.add(String(key));
            if (n && n !== 'bye' && n !== 'tbd') names.add(n);
        }
    }
    return { keys, names };
}

function playerInRound(key, name, players) {
    if (isRealKey(key) && players.keys.has(String(key))) return true;
    const n = norm(name);
    if (!n || n === 'bye' || n === 'tbd') return false;
    if (players.names.has(n)) return true;
    for (const pn of players.names) {
        if (nameHits(pn, n) || nameHits(n, pn)) return true;
    }
    return false;
}

function samePlayer(key, name, who) {
    if (isRealKey(key) && isRealKey(who.key) && String(key) === String(who.key)) return true;
    return !!(name && who.name && nameHits(name, who.name));
}

function findFeeder(laterMatch, prevMatches, side) {
    const key = laterMatch[`${side}Key`];
    const name = laterMatch[`${side}Name`];
    if (isByeName(name) || isTbdName(name)) return null;
    if (!isRealKey(key) && !name) return null;

    const byWinner = prevMatches.find(p => {
        const w = winnerSideOf(p);
        if (!w) return false;
        if (isRealKey(key) && isRealKey(w.key) && String(w.key) === String(key)) return true;
        return !!(name && w.name && nameHits(w.name, name));
    });
    if (byWinner) return byWinner;

    return prevMatches.find(p => {
        if (isRealKey(key) && (String(p.player1Key) === String(key) || String(p.player2Key) === String(key))) {
            return true;
        }
        return !!(name && (nameHits(p.player1Name, name) || nameHits(p.player2Name, name)));
    }) || null;
}

function byeMatchFromPlayer(template, laterMatch, side, seq) {
    const name = laterMatch[`${side}Name`] || '';
    const key = laterMatch[`${side}Key`];
    return {
        ...template,
        matchKey:    `bye-derived-${seq}`,
        player1Name: name,
        player1Key:  isRealKey(key) ? String(key) : '',
        player1Seed: laterMatch[`${side}Seed`] ?? null,
        player1Rank: laterMatch[`${side}Rank`] ?? null,
        player2Name: 'BYE',
        player2Key:  '',
        player2Seed: null,
        player2Rank: null,
        winner:      (isRealKey(key) || name) ? 'player1' : null,
        setScores:   [],
        status:      (isRealKey(key) || name) ? 'Finished' : 'Not Started',
        isLive:      false,
        isBye:       true,
        synthetic:   true,
    };
}

// A later-round player with no previous-round feeder either won an unpublished
// match (walkover — pair them with the leftover earlier-round winner) or
// entered on a bye. Real names only.
function synthMissingPrevMatch(laterMatch, side, earlierMatches, prevMatches, template, seq) {
    const key = laterMatch[`${side}Key`];
    const name = laterMatch[`${side}Name`];
    const prevPlayers = allPlayersOf(prevMatches);
    if (earlierMatches && earlierMatches.length) {
        const orphans = [];
        for (const em of earlierMatches) {
            const w = winnerSideOf(em);
            if (!w?.name || isTbdName(w.name)) continue;
            if (playerInRound(w.key, w.name, prevPlayers)) continue;
            orphans.push(w);
        }
        const opponent = orphans.find(o => !samePlayer(key, name, o));
        if (opponent) {
            const advanced = {
                key, name,
                seed: laterMatch[`${side}Seed`],
                rank: laterMatch[`${side}Rank`],
            };
            const synth = synthLaterMatch(template, seq, advanced, opponent, [ { matches: [laterMatch] } ]);
            if (!synth.winner) {
                synth.winner = 'player1';
                synth.status = 'Finished';
            }
            return synth;
        }
    }
    if (name && !isTbdName(name) && !isByeName(name)) {
        return byeMatchFromPlayer(template, laterMatch, side, seq);
    }
    return null;
}

/**
 * GENERAL PATH: walk the winner tree BACKWARD from the latest round so
 * children of slot i occupy 2i and 2i+1. Works for any ATP/WTA draw without
 * a printed-sheet override — first-round feed/matchKey order is not assumed.
 * Latest-round feed order is the unverified visual root.
 */
function layoutTreeFromLatest(rounds) {
    const ordered = rounds.slice().sort((a, b) => b.order - a.order);
    if (ordered.length < 2) return;

    const latest = ordered[ordered.length - 1];
    latest.matches.forEach((m, i) => { m._treeSlot = i; });

    let seq = 0;
    for (let r = ordered.length - 1; r >= 1; r--) {
        const curr = ordered[r];
        const prev = ordered[r - 1];
        const earlier = r >= 2 ? ordered[r - 2] : null;
        const currSorted = curr.matches.slice().sort((a, b) => (a._treeSlot ?? 0) - (b._treeSlot ?? 0));
        const width = Math.max(prev.matches.length, currSorted.length * 2);
        const placed = new Array(width).fill(null);
        const claimed = new Set();

        for (const cm of currSorted) {
            const slot = cm._treeSlot ?? 0;
            for (const [side, offset] of [['player1', 0], ['player2', 1]]) {
                const dest = 2 * slot + offset;
                let feeder = findFeeder(cm, prev.matches, side);
                if (feeder && claimed.has(feeder)) feeder = null;
                if (!feeder) {
                    const template = prev.matches[0] || cm;
                    feeder = synthMissingPrevMatch(
                        cm, side, earlier?.matches || [], prev.matches, template, seq++);
                }
                if (!feeder) continue;
                if (!prev.matches.includes(feeder)) prev.matches.push(feeder);
                while (placed.length <= dest) placed.push(null);
                if (!placed[dest]) {
                    placed[dest] = feeder;
                    claimed.add(feeder);
                    feeder._treeSlot = dest;
                }
            }
        }

        // Leftovers are not part of this parent tree — append AFTER the
        // 2·N feeder slots. Never pack them into a structural hole (that
        // would break adjacent-slot pairing).
        const treeWidth = currSorted.length * 2;
        for (const m of prev.matches) {
            if (claimed.has(m)) continue;
            m._treeSlot = Math.max(placed.length, treeWidth);
            placed.push(m);
            claimed.add(m);
        }

        const dense = placed.filter(Boolean);
        dense.sort((a, b) => (a._treeSlot ?? 0) - (b._treeSlot ?? 0));
        prev.matches = dense;
    }

    for (const r of ordered) {
        r.matches.sort((a, b) => (a._treeSlot ?? 0) - (b._treeSlot ?? 0));
        for (const m of r.matches) delete m._treeSlot;
    }
}

/**
 * assignSlotOrder(rounds, tour, tournamentName):
 * orders each round and stamps `slotIndex` on every match.
 *
 * slotOrderVerified === true  only when a BRACKET_SLOTS emergency override
 * placed the first round in printed-draw order. Overrides are live-fire only.
 *
 * slotOrderVerified === false  on the general path: slotIndex is a consistent
 * binary-tree layout derived from winner→parent links (adjacent slots meet
 * next round) but is NOT claimed as the official printed sheet. matchKey is
 * never treated as bracket order.
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
        const leaves = leafCount(rounds, pairs);
        expandByes(rounds, leaves);
        // Official first-round is the root — walk FORWARD so printed order wins.
        placeLaterFromParents(rounds);
    } else {
        leafCount(rounds, null);
        // Latest-round pairing is the root — walk BACKWARD so children are
        // adjacent even when first-round feed order is scrambled.
        layoutTreeFromLatest(rounds);
        const leaves = leafCount(rounds, null);
        expandByes(rounds, leaves);
    }

    for (const r of rounds) {
        r.matches.forEach((m, i) => { m.slotIndex = i; });
        r.slotOrderVerified = verified;
    }
    return rounds;
}
