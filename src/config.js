// ===================================
// Central configuration
// ===================================

// Cache TTLs (seconds)
// Philosophy: stale-while-acceptable. Rankings/results can be 1-3 days old.
// Live scores need to feel live: the Scores client polls /api/livescore every
// ~15s when matches are in play, so a live/scheduled/delayed board is cached
// for 60s (edge only). Finished-only boards stay at 2 min.
export const TTL = {
    livescore:     60,            // 60s  — live, scheduled, or delayed
    livescoreIdle: 2  * 60,       //  2 min — finished-only / empty board (nothing can go live)
    livescoreSeen: 12 * 60 * 60,  // 12 hr — last InPlay / sticky-completion snapshot
    hub:           5  * 60,       //  5 min — featured match + today's board
    drawsLive:     5  * 60,       //  5 min — in-play draw page (not the ticker)
    fixtures:      24 * 60 * 60,  // 24 hr  — match results finalized same day
    standings:     48 * 60 * 60,  // 48 hr  — ATP/WTA points update weekly; 48hr is safe
    tournaments:   48 * 60 * 60,  // 48 hr  — tournament schedule rarely changes
    players:       72 * 60 * 60,  // 72 hr  — player stats/profiles, very stable
    h2h:           48 * 60 * 60,  // 48 hr  — new H2H results are rare events
    // playerStats past-matches. Shared so PR #17 (player route guards) can
    // import this instead of keeping a local 6h literal.
    playerPastMatches: 24 * 60 * 60,
    // Negative cache for a profile with no birthday, or an upstream error on
    // profile / titles / tournament map. Cache API only — never KV.
    edgeMiss:      10 * 60,
};

// Estimated daily API calls with these TTLs and moderate traffic:
//   livescore:   ~250–500/day during live windows (60s TTL, ~8hrs play, 1–2 tours)
//   standings:   ~1/day
//   tournaments: ~1/day
//   fixtures:    ~3/day (one per active tournament)
//   players:     ~5–20/day (on-demand, cached per player)
//   h2h:         ~10–30/day (on-demand, cached per pair)
//   Total:       ~550–1100/day vs. 8,000/day Starter limit  (~7–14% utilization)

// API-Tennis event type keys (from get_events)
export const EVENT_TYPES = {
    ATP: '1',
    WTA: '2',
};
