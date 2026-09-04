// ===================================
// Data Transform Layer
// ===================================
// Normalizes raw api-tennis.com responses into our own clean schema.
// Field names verified against live API responses.

// ── Standings ─────────────────────────────────────────────────────────────────
// Raw fields: place, player, player_key, league, movement ("up"/"down"), country, points
export function transformStandings(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(r => ({
        rank:      Number(r.place)      || 0,
        movement:  r.movement === 'up' ? 1 : r.movement === 'down' ? -1 : 0,
        playerKey: String(r.player_key || ''),
        name:      r.player            || '',
        country:   r.country           || '',
        points:    Number(r.points)    || 0,
        tour:      r.league            || '',
    }));
}

// ── Tournaments ───────────────────────────────────────────────────────────────
// Raw fields: tournament_key, tournament_name, event_type_key, event_type_type, tournament_sourface (API typo)
export function transformTournaments(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(r => ({
        tournamentKey: String(r.tournament_key  || ''),
        name:          (r.tournament_name       || '').trim(),
        eventTypeKey:  String(r.event_type_key  || ''),
        eventType:     r.event_type_type        || '',
        surface:       r.tournament_sourface    || '',  // note: API has typo "sourface"
    }));
}

// ── Set score helpers ─────────────────────────────────────────────────────────

// Extracts per-set scores from pointByPoint game log.
// Returns e.g. [{set:'Set 1', p1:6, p2:1, tiebreak:null}, {set:'Set 2', p1:7, p2:6, tiebreak:{p1:3,p2:7}}]
function parseSetScores(pbp) {
    if (!Array.isArray(pbp) || !pbp.length) return [];

    // Last game of each set_number key carries the cumulative game score
    const setMap = {};
    for (const game of pbp) {
        const key = game.set_number || 'Set 1';
        setMap[key] = game.score;          // later game wins
    }

    const result = [];
    for (const [key, score] of Object.entries(setMap)) {
        if (key.includes('TieBreak')) continue;   // merged into parent set below
        const [p1, p2] = (score || '0 - 0').split(' - ').map(s => parseInt(s) || 0);
        const tbKey = key + ' TieBreak';
        let tiebreak = null;
        if (setMap[tbKey]) {
            const [t1, t2] = (setMap[tbKey] || '0 - 0').split(' - ').map(s => parseInt(s) || 0);
            tiebreak = { p1: t1, p2: t2 };
        }
        result.push({ set: key, p1, p2, tiebreak });
    }

    return result.sort((a, b) => a.set.localeCompare(b.set));
}

// Returns the current point score ("30 - 15") if a game is in progress, else null.
function parseCurrentGame(pbp) {
    if (!Array.isArray(pbp) || !pbp.length) return null;
    const last = pbp[pbp.length - 1];
    // An unfinished game has no serve_winner and no serve_lost
    if (!last.serve_winner && !last.serve_lost) {
        const pts = last.points || [];
        return pts.length ? pts[pts.length - 1].score : '0 - 0';
    }
    return null;
}

// ── Fixtures / Results ────────────────────────────────────────────────────────
// Raw fields: event_key, event_date, event_time, event_first_player, first_player_key,
//             event_second_player, second_player_key, event_final_result, event_winner,
//             event_status, event_type_type, tournament_name, tournament_key,
//             tournament_round, tournament_season, event_live, pointbypoint
export function transformFixtures(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(r => {
        const pbp = r.pointbypoint || [];
        return {
            matchKey:       String(r.event_key             || ''),
            tournamentKey:  String(r.tournament_key        || ''),
            tournamentName: (r.tournament_name             || '').trim(),
            date:           r.event_date                   || '',
            time:           r.event_time                   || '',
            status:         r.event_status                 || '',
            round:          r.tournament_round             || '',
            season:         r.tournament_season            || '',
            eventType:      r.event_type_type              || '',
            player1Key:     String(r.first_player_key      || ''),
            player1Name:    r.event_first_player           || '',
            player1Logo:    r.event_first_player_logo      || '',
            player2Key:     String(r.second_player_key     || ''),
            player2Name:    r.event_second_player          || '',
            player2Logo:    r.event_second_player_logo     || '',
            // "1 - 2" = sets won by each player (fallback if no pointByPoint)
            finalResult:    r.event_final_result           || '',
            winner:         r.event_winner                 || '',   // "First Player" | "Second Player"
            isLive:         r.event_live === '1' || r.event_status === '1',
            // Structured scoring
            setScores:      parseSetScores(pbp),    // [{set, p1, p2, tiebreak}]
            currentGame:    parseCurrentGame(pbp),  // "30 - 15" or null
        };
    });
}

// ── Live Scores ────────────────────────────────────────────────────────────────
// Same shape as fixtures — live flag already set via event_live field
export function transformLivescore(raw) {
    return transformFixtures(raw);
}

// ── Player Profile ─────────────────────────────────────────────────────────────
// Raw fields (verified): player_key, player_name, player_full_name, player_country,
//   player_bday, player_logo, stats[] { season, type, rank, titles,
//   matches_won, matches_lost, hard_won, hard_lost, clay_won, clay_lost, grass_won, grass_lost }
export function transformPlayer(raw) {
    if (!Array.isArray(raw) || !raw[0]) return null;
    const r = raw[0];
    const singlesStats = (r.stats || []).filter(s => s.type === 'singles');
    return {
        playerKey: String(r.player_key      || ''),
        name:      r.player_full_name       || r.player_name || '',
        country:   r.player_country         || '',
        birthdate: r.player_bday            || '',
        logoUrl:   r.player_logo            || '',
        seasons:   _parsePlayerSeasons(singlesStats),
    };
}

// RapidAPI player/profile → our player shape. Same ID namespace as draws/fixtures/
// rankings, so identity (name/country/rank) is correct for the keys used site-wide.
// Raw shape: { id, name, country:{name,acronym}, countryAcr, currentRank, birthday }.
// No year-by-year seasons here — career/surface stats come from /api/player-stats
// (also RapidAPI), so seasons is intentionally empty (renderSurfaceBars uses stats).
export function transformRapidProfile(raw) {
    const r = raw?.data || raw;
    if (!r || r.id == null) return null;
    return {
        playerKey:   String(r.id),
        name:        r.name || '',
        country:     r.country?.name || r.countryAcr || '',
        birthdate:   r.birthday || '',
        logoUrl:     '',
        currentRank: r.currentRank ?? null,
        seasons:     [],
    };
}

function _parsePlayerSeasons(stats) {
    return stats.map(s => ({
        year:   s.season        || '',
        rank:   Number(s.rank)  || 0,
        titles: Number(s.titles)|| 0,
        wins:   Number(s.matches_won)  || 0,
        losses: Number(s.matches_lost) || 0,
        hardW:  Number(s.hard_won)     || 0,
        hardL:  Number(s.hard_lost)    || 0,
        clayW:  Number(s.clay_won)     || 0,
        clayL:  Number(s.clay_lost)    || 0,
        grassW: Number(s.grass_won)    || 0,
        grassL: Number(s.grass_lost)   || 0,
    }));
}

// ── H2H ───────────────────────────────────────────────────────────────────────
export function transformH2H(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        h2hMatches:         transformFixtures(raw.H2H            || []),
        player1Recent:      transformFixtures(raw.firstPlayer    || []),
        player2Recent:      transformFixtures(raw.secondPlayer   || []),
    };
}
