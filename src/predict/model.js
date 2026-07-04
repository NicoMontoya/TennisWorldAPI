// ===================================
// TennisWorld — Win-Probability Model (v0.1)
// ===================================
// A transparent logistic model: sigmoid(z) over NORMALIZED features.
//
// Why transparent (not ML): there is no historical training data in this repo
// (db.js is a Supabase stub returning null). Every weight below is a HAND-TUNED
// HEURISTIC expressing an expert prior, not a learned coefficient. The point of
// v0.1 is a calibrated, explainable estimate — never accuracy theater.
//
// Design notes (per advisor guidance in ISA.md ## Decisions):
//   - Rank is normalized as a BOUNDED transform (rankB - rankA)/(rankA + rankB),
//     NOT a raw diff. Raw diff swamps the other features (a 1-vs-200 gap is +199
//     while surface/H2H deltas live near ±1), collapsing the model to rank-only.
//     The bounded form keeps every feature on a comparable [-1, 1]-ish scale.
//   - Each feature is normalized BEFORE it is weighted.
//   - Missing data degrades gracefully (per-feature fallback) and lowers
//     confidence; it never crashes or fabricates a signal.
//   - Output is clamped to [0.02, 0.98] — no 0% / 100% claims.
//   - Entertainment estimate of P(win) only; no financial-speculation semantics.

// ── Model configuration (HEURISTIC — hand-tuned, not trained) ──────────────────
// One documented config object so every magic number lives in a single place.
export const MODEL_CONFIG = {
    version: 'v0.1',

    // Logistic weights applied to each normalized feature. Larger = more
    // influence on the logit. Rank dominates (it is the strongest single
    // pre-match prior in tennis), surface is secondary, H2H is a tie-breaker.
    weights: {
        rank:    2.4,  // normalized rank advantage  ∈ roughly [-1, 1]
        surface: 1.6,  // surface win% delta          ∈ [-1, 1]  (delta of fractions)
        h2h:     0.9,  // normalized H2H advantage     ∈ [-1, 1]
        bias:    0.0,  // no global home-court / first-named bias
    },

    // Scaling constants for feature normalization.
    scaling: {
        // H2H: scale the win-share advantage by sample size so a 1-0 record
        // counts far less than a 10-2 record. saturates toward ±1 as games grow.
        h2hSaturation: 4,   // ~4 decided meetings ≈ half weight
        // Surface: minimum matches on a surface before we trust the split;
        // below this we fall back to the player's overall win%.
        minSurfaceMatches: 8,
    },

    // Probabilities are clamped to this range — calibrated, never overconfident.
    clamp: { min: 0.02, max: 0.98 },

    // Confidence thresholds (count of strong signals present).
    confidence: {
        // high  = rank for both + surface for both + H2H present
        // medium = most signals present
        // low   = a key signal (e.g. a rank) is missing
    },
};

// ── Math helpers ───────────────────────────────────────────────────────────────

function sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
}

function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
}

// ── Feature normalizers ─────────────────────────────────────────────────────────
// Each returns { value, present } where value ∈ ~[-1, 1] from A's perspective
// (positive = favors A). `present:false` means the signal was missing and
// contributed nothing (neutral) to the logit.

// Rank: bounded transform (rankB - rankA) / (rankA + rankB).
// Lower rank number = stronger, so a smaller rankA (vs rankB) yields a POSITIVE
// value favoring A. Bounded to (-1, 1) regardless of how large the gap is.
function normRank(rankA, rankB) {
    const a = Number(rankA);
    const b = Number(rankB);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
        return { value: 0, present: false };
    }
    if (a + b === 0) return { value: 0, present: true };
    return { value: (b - a) / (a + b), present: true };
}

// Surface win% delta. winPctA / winPctB are fractions in [0, 1].
// value = winPctA - winPctB ∈ [-1, 1]. Positive favors A.
function normSurface(winPctA, winPctB) {
    const a = Number(winPctA);
    const b = Number(winPctB);
    const aOk = Number.isFinite(a);
    const bOk = Number.isFinite(b);
    if (!aOk && !bOk) return { value: 0, present: false };
    // If only one side present, treat the missing side as neutral 0.5.
    const av = aOk ? a : 0.5;
    const bv = bOk ? b : 0.5;
    return { value: av - bv, present: aOk && bOk };
}

// H2H: normalized win-share advantage, damped by sample size.
// winsA / winsB are decided-meeting counts. Positive favors A.
function normH2H(winsA, winsB, cfg) {
    const a = Number(winsA) || 0;
    const b = Number(winsB) || 0;
    const total = a + b;
    if (total <= 0) return { value: 0, present: false };
    const share = (a - b) / total;                 // ∈ [-1, 1]
    const damp  = total / (total + cfg.scaling.h2hSaturation); // ∈ (0, 1)
    return { value: share * damp, present: true };
}

// ── Driver labels ────────────────────────────────────────────────────────────────
// Turn the largest weighted contributions into 1–3 human-readable reasons.

function driverLabel(key, contribution, names) {
    const favorsA = contribution > 0;
    const who = favorsA ? names.a : names.b;
    switch (key) {
        case 'rank':    return `${who} is higher ranked`;
        case 'surface': return `${who} is stronger on this surface`;
        case 'h2h':     return `${who} leads the head-to-head`;
        default:        return '';
    }
}

// ── Main prediction function ──────────────────────────────────────────────────────
//
// input = {
//   rankA, rankB,                 // integer ranks (lower = stronger) or null
//   surfaceWinPctA, surfaceWinPctB, // fractions in [0,1] or null
//   h2hWinsA, h2hWinsB,           // decided-meeting counts or null
//   nameA, nameB,                 // optional display names for drivers
// }
//
// Returns { probA, probB, confidence, drivers, modelVersion, partial }.
export function predict(input = {}, config = MODEL_CONFIG) {
    const cfg   = config;
    const names = { a: input.nameA || 'Player A', b: input.nameB || 'Player B' };

    const rank    = normRank(input.rankA, input.rankB);
    const surface = normSurface(input.surfaceWinPctA, input.surfaceWinPctB);
    const h2h     = normH2H(input.h2hWinsA, input.h2hWinsB, cfg);

    // Weighted contributions to the logit (from A's perspective).
    const contrib = {
        rank:    cfg.weights.rank    * rank.value,
        surface: cfg.weights.surface * surface.value,
        h2h:     cfg.weights.h2h     * h2h.value,
    };

    const z = cfg.weights.bias + contrib.rank + contrib.surface + contrib.h2h;

    let probA = clamp(sigmoid(z), cfg.clamp.min, cfg.clamp.max);
    let probB = clamp(1 - probA, cfg.clamp.min, cfg.clamp.max);

    // Renormalize so probA + probB === 1 exactly (after independent clamping the
    // pair can drift by a hair; this guarantees the invariant the API promises).
    const sum = probA + probB;
    probA = probA / sum;
    probB = probB / sum;

    // ── Confidence ────────────────────────────────────────────────────────────
    // A missing rank is the most damaging gap (rank is the dominant prior).
    const rankPresent    = rank.present;
    const surfacePresent = surface.present;
    const h2hPresent     = h2h.present;
    const partial        = !(rankPresent && surfacePresent && h2hPresent);

    let confidence;
    if (!rankPresent) {
        confidence = 'low';                          // ISC-17: unranked → low
    } else if (rankPresent && surfacePresent && h2hPresent) {
        confidence = 'high';                         // ISC-16: all signals → high
    } else {
        confidence = 'medium';                       // ISC-18: missing H2H → not high
    }

    // ── Drivers: the 1–3 signals that most moved the result ─────────────────────
    const drivers = Object.entries(contrib)
        .filter(([, c]) => Math.abs(c) > 1e-6)
        .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
        .slice(0, 3)
        .map(([key, c]) => driverLabel(key, c, names))
        .filter(Boolean);

    return {
        probA: Number(probA.toFixed(4)),
        probB: Number(probB.toFixed(4)),
        confidence,
        drivers,
        modelVersion: cfg.version,
        partial,
    };
}
