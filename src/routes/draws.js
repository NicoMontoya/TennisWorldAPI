import { cache }    from '../cache.js';
import { rapidAPI } from '../apiClient.js';
import { TTL }      from '../config.js';
import { assignSlotOrder } from '../bracketSlots.js';

// roundId → { name, order } (order 1 = Final, higher = earlier round)
const ROUND = {
    12: { name: 'Final',          order: 1 },
    10: { name: 'Semi-finals',    order: 2 },
    9:  { name: 'Quarter-finals', order: 3 },
    7:  { name: 'Round of 16',    order: 4 },
    6:  { name: 'Round of 32',    order: 5 },
    5:  { name: 'Round of 64',    order: 6 },
    4:  { name: 'Round of 128',   order: 7 },
    8:  { name: 'Round Robin',    order: 1.5 },
    11: { name: 'Bronze Play-off',order: 1.5 },
};

// "6-2 5-7 6-4" → ["6-2", "5-7", "6-4"]
function parseScore(result) {
    if (!result) return [];
    return result.trim().split(/\s+/);
}

// ── Phantom-fixture filter ────────────────────────────────────────────────────
// The upstream feed sometimes leaves stale speculative fixtures in a round
// (e.g. an unplayed "R32: Tiafoe vs Bublik" long after the real R32 finished
// with different pairings). They inflate a 16-slot round to 18 matches, which
// misaligns every downstream slot computation (DrawBracket, picks, scoring)
// and renders ghost "pickable" cards. Rule — an UNSTARTED fixture is phantom if:
//   (a) either player was already eliminated in an earlier round, or
//   (b) either player already appears in a completed match of the SAME round.
// Completed and live matches are always kept. Rounds iterate earliest→latest
// (order: 7 = R128 … 1 = Final) so elimination knowledge accumulates forward.
function stripPhantomFixtures(rounds) {
    const eliminated = new Set();
    const isReal = k => k != null && k !== '' && k !== 'null' && k !== 'undefined';

    const earliestFirst = rounds.slice().sort((a, b) => b.order - a.order);
    for (const round of earliestFirst) {
        const completedPlayers = new Set();
        for (const m of round.matches) {
            if (!m.winner) continue;
            if (isReal(m.player1Key)) completedPlayers.add(String(m.player1Key));
            if (isReal(m.player2Key)) completedPlayers.add(String(m.player2Key));
        }
        round.matches = round.matches.filter(m => {
            if (m.winner || m.isLive) return true;
            const p1 = String(m.player1Key), p2 = String(m.player2Key);
            if ((isReal(p1) && eliminated.has(p1)) || (isReal(p2) && eliminated.has(p2))) return false;
            if ((isReal(p1) && completedPlayers.has(p1)) || (isReal(p2) && completedPlayers.has(p2))) return false;
            return true;
        });
        for (const m of round.matches) {
            if (m.winner === 'player1' && isReal(m.player2Key)) eliminated.add(String(m.player2Key));
            if (m.winner === 'player2' && isReal(m.player1Key)) eliminated.add(String(m.player1Key));
        }
    }
    return rounds.filter(r => r.matches.length > 0);
}

// GET /api/draws?tournamentKey=XXXX&season=YYYY
// tournamentKey is the new RapidAPI tournament id.
// season is ignored (new API returns full history per tournament id).
export async function handleDraws(request, env) {
    const { searchParams } = new URL(request.url);
    const tournamentKey = searchParams.get('tournamentKey');
    if (!tournamentKey) throw new Error('tournamentKey is required');

    const tour = (searchParams.get('tour') || 'ATP').toUpperCase();

    const cacheKey = ['draws12', tournamentKey, tour];
    const cached   = await cache.get(env, ...cacheKey);
    if (cached) return cached.data;

    // ── Fetch results, fixtures, and tournament info in parallel ─────────────
    let resultsData, fixturesData, infoData;
    try {
        [resultsData, fixturesData, infoData] = await Promise.all([
            rapidAPI.tournamentResults(env, tour, tournamentKey),
            rapidAPI.tournamentFixtures(env, tour, tournamentKey),
            rapidAPI.tournamentInfo(env, tour, tournamentKey).catch(() => null),
        ]);
    } catch (err) {
        const stale = await cache.getStale(env, ...cacheKey);
        if (stale) return stale.data;
        throw err;
    }

    const completedMatches = resultsData?.data?.singles  || [];
    // Filter upcoming to singles only — doubles teams have "/" in player names
    const upcomingMatches  = (fixturesData?.data || []).filter(f =>
        !f.player1?.name?.includes('/') && !f.player2?.name?.includes('/')
    );

    // ── Build playerID → seed map from remaining fixtures ─────────────────────
    // Seeds are set at the start of the tournament and don't change.
    // Once a match is played it leaves the fixtures table, but the player's
    // seed can be inferred from whatever fixtures still reference them.
    const seedMap = new Map(); // playerId(number) → seed(number)
    for (const f of upcomingMatches) {
        if (f.seed1 && f.player1Id) seedMap.set(f.player1Id, parseInt(f.seed1));
        if (f.seed2 && f.player2Id) seedMap.set(f.player2Id, parseInt(f.seed2));
    }

    // ── Derive tournament name ────────────────────────────────────────────────
    const tournamentName = infoData?.data?.name || '';

    // ── Transform a raw match → our standard fixture shape ───────────────────
    function transformMatch(m, isLive = false) {
        const p1Id  = m.player1Id;
        const p2Id  = m.player2Id;
        const won   = m.match_winner;
        const winner = won ? (won === p1Id ? 'player1' : 'player2') : null;

        return {
            matchKey:    String(m.id),
            player1Name: m.player1?.name  || '',
            player1Key:  String(p1Id),
            player2Name: m.player2?.name  || '',
            player2Key:  String(p2Id),
            winner,
            setScores:   parseScore(m.result),
            round:       ROUND[m.roundId]?.name || `Round ${m.roundId}`,
            roundId:     m.roundId,
            status:      winner ? 'Finished' : (isLive ? 'Live' : 'Not Started'),
            isLive,
            date:        m.date || null,
            player1Rank: null, // enriched below
            player2Rank: null,
            player1Seed: seedMap.get(p1Id) || null,
            player2Seed: seedMap.get(p2Id) || null,
            eventType:   `${tour} Singles`,
            tournamentName,
        };
    }

    const transformed = [
        ...completedMatches.map(m => transformMatch(m, false)),
        ...upcomingMatches.map(m  => transformMatch(m, false)),
    ];

    // ── Enrich with live rankings for unseeded players ────────────────────────
    try {
        const rankData = await rapidAPI.rankings(env, tour);
        const rankList = rankData?.data || [];
        const rankMap  = new Map(rankList.map(r => [r.player?.id, r.position]));
        for (const f of transformed) {
            if (!f.player1Rank) f.player1Rank = rankMap.get(Number(f.player1Key)) || null;
            if (!f.player2Rank) f.player2Rank = rankMap.get(Number(f.player2Key)) || null;
        }
    } catch (_) {
        // Rankings are best-effort
    }

    // ── Group by round ────────────────────────────────────────────────────────
    const roundMap = {};
    for (const f of transformed) {
        const ri = f.roundId;
        if (!ROUND[ri]) continue; // skip qualifying / unknown
        if (!roundMap[ri]) roundMap[ri] = { round: f.round, order: ROUND[ri].order, matches: [] };
        roundMap[ri].matches.push(f);
    }

    const rounds = assignSlotOrder(
        stripPhantomFixtures(
            Object.values(roundMap)
                .sort((a, b) => a.order - b.order)
                .filter(r => r.matches.length > 0)
        ),
        tour, tournamentName
    );

    const result = {
        tournamentKey,
        name:         tournamentName,
        totalMatches: completedMatches.length,
        rounds,
    };

    // ── Adaptive cache TTL ────────────────────────────────────────────────────
    // A fixed 24h TTL made LIVE draws stale — new results could take a day to
    // show. Key the TTL to tournament state so an in-progress draw refreshes fast
    // while a finished/not-started one still caches long. Synthetic (placeholder)
    // matches don't count as real play.
    const allMatches = rounds.flatMap(r => r.matches);
    const anyLive    = allMatches.some(m => m.isLive);
    const anyDecided = allMatches.some(m => m.winner && !m.synthetic);
    const finalDone  = rounds.some(r => /final/i.test(r.round)
                                     && r.matches.some(m => m.winner));

    let ttl;
    if (anyLive)                 ttl = TTL.livescore;   //   5 min — matches in play now
    else if (anyDecided && !finalDone) ttl = 10 * 60;  //  10 min — tournament in progress
    else if (!anyDecided)        ttl = 60 * 60;         //   1 hr  — not started (draw/qualifiers settling)
    else                         ttl = TTL.fixtures;    //  24 hr  — completed, nothing left to change

    await cache.set(env, ttl, result, ...cacheKey);
    return result;
}
