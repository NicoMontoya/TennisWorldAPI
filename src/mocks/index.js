// ===================================
// Mock Data Layer
// ===================================
// Returns realistic static data for every API method.
// Used when DEMO_MODE=true or when TENNIS_API_KEY is absent.
// Keeps all pages functional offline — great for CI, demos, and new devs.

import fixturesMock    from './fixtures.js';
import standingsMock   from './standings.js';
import tournamentsMock from './tournaments.js';
import playerMock      from './player.js';

const MOCKS = {
    get_fixtures:    () => fixturesMock,
    // get_livescore retired — Scores live is MatchStat, not api-tennis.
    get_standings:   () => standingsMock,
    get_tournaments: () => tournamentsMock,
    get_players:     () => playerMock,
    // H2H: return a structure with H2H, firstPlayer, secondPlayer arrays
    get_H2H: () => ({
        H2H:          fixturesMock.slice(0, 1),
        firstPlayer:  fixturesMock.slice(0, 2),
        secondPlayer: fixturesMock.slice(1, 2),
    }),
};

/**
 * getMock(method, params)
 * Returns mock data for the given API-Tennis method name.
 * Throws if the method is unknown (helps catch typos early).
 */
export function getMock(method, _params = {}) {
    const factory = MOCKS[method];
    if (!factory) throw new Error(`No mock defined for API method: "${method}"`);
    return factory();
}
