// ===================================
// Central configuration
// ===================================

// Cache TTLs (seconds)
// Philosophy: stale-while-acceptable. Rankings/results can be 1-3 days old.
// Live scores still need reasonable freshness for the ticker to feel live.
export const TTL = {
    livescore:   5  * 60,        //  5 min  — only data that truly changes mid-match
    fixtures:    24 * 60 * 60,   // 24 hr   — match results finalized same day
    standings:   48 * 60 * 60,   // 48 hr   — ATP/WTA points update weekly; 48hr is safe
    tournaments: 48 * 60 * 60,   // 48 hr   — tournament schedule rarely changes
    players:     72 * 60 * 60,   // 72 hr   — player stats/profiles, very stable
    h2h:         48 * 60 * 60,   // 48 hr   — new H2H results are rare events
};

// Estimated daily API calls with these TTLs and moderate traffic:
//   livescore:   ~100/day (only during active tournaments, ~8hrs live play)
//   standings:   ~1/day
//   tournaments: ~1/day
//   fixtures:    ~3/day (one per active tournament)
//   players:     ~5–20/day (on-demand, cached per player)
//   h2h:         ~10–30/day (on-demand, cached per pair)
//   Total:       ~130–160/day vs. 8,000/day Starter limit  (~2% utilization)

// API-Tennis event type keys (from get_events)
export const EVENT_TYPES = {
    ATP: '1',
    WTA: '2',
};
