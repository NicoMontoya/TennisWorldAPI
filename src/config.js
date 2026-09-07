// ===================================
// Central configuration
// ===================================

// Cache TTLs (seconds)
// Philosophy: stale-while-acceptable. Rankings/results can be 1-3 days old.
// Live scores need to feel live: the Scores client polls /api/livescore every
// ~15s when matches are in play, so the cache floor must be well under a minute.
export const TTL = {
    livescore:     30,            // 30s  — live, or match-day fixtures that can go InPlay
    livescoreIdle: 2  * 60,       //  2 min — finished-only / empty board (nothing can go live)
    hub:           5  * 60,       //  5 min — featured match + today's board
    drawsLive:     5  * 60,       //  5 min — in-play draw page (not the ticker)
    fixtures:      24 * 60 * 60,  // 24 hr  — match results finalized same day
    standings:     48 * 60 * 60,  // 48 hr  — ATP/WTA points update weekly; 48hr is safe
    tournaments:   48 * 60 * 60,  // 48 hr  — tournament schedule rarely changes
    players:       72 * 60 * 60,  // 72 hr  — player stats/profiles, very stable
    h2h:           48 * 60 * 60,  // 48 hr  — new H2H results are rare events
};

// Estimated daily API calls with these TTLs and moderate traffic:
//   livescore:   ~500–1000/day during live windows (30s TTL, ~8hrs play, 1–2 tours)
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
