// ===================================
// TennisWorld — /api/predict route
// ===================================
// GET /api/predict?playerKeyA=&playerKeyB=&tour=&surface=&round=
//
// Fetches three signals — rank, surface win%, H2H — by REUSING the existing
// route handlers (standings, player-stats, h2h), runs the transparent
// win-probability model (src/predict/model.js), caches the result in KV with an
// order-independent canonical pair key + explicit TTL, and returns it through the
// standard { ok, data } envelope (jsonResponse adds it in index.js).
//
// Degrades gracefully: any missing signal becomes a model fallback (neutral H2H,
// overall-winPct surface, low-confidence on missing rank) instead of a 500.
//
// NOTE on data sources / ID namespace: standings, player-stats and h2h all use
// the same RapidAPI player-id namespace (e.g. Sinner = 47275), so the player keys
// join cleanly across all three. (surface-standings uses a DIFFERENT namespace,
// so we intentionally do NOT use it here — player-stats gives per-key surface
// splits in the right namespace.)

import { cache }            from '../cache.js';
import { TTL }              from '../config.js';
import { predict }          from '../predict/model.js';
import { handleStandings }  from './standings.js';
import { handlePlayerStats } from './playerStats.js';
import { handleH2H }        from './h2h.js';

const PREDICT_TTL = 6 * 60 * 60; // 6h — refreshes well within rank/surface cadence

// Build a 400-style error the index.js error handler maps to status 400.
function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

// Call an existing handler with a synthetic Request (same pattern as the cron in
// index.js). Returns null on any failure so a missing signal never crashes /predict.
async function callHandler(handler, path, env) {
    try {
        const req = new Request(`https://internal${path}`);
        return await handler(req, env);
    } catch {
        return null;
    }
}

// Surface fraction for one player from /api/player-stats data.
// Uses the requested surface split when it has a usable sample; otherwise falls
// back to the player's overall win% (per advisor: missing surface → overall).
function surfaceFraction(stats, surface) {
    if (!stats) return null;
    const split = stats.surface?.[surface];
    if (split) {
        const total = (split.wins || 0) + (split.losses || 0);
        if (total >= 1) return split.wins / total;
    }
    // Fallback: overall season win% (0–100) → fraction.
    if (typeof stats.winPct === 'number') return stats.winPct / 100;
    return null;
}

// Order-independent canonical KV key parts. Sorting the keys means predict(A,B)
// and predict(B,A) hit the SAME cache entry; we flip the cached probs to match
// the requested orientation.
function canonicalCacheParts(keyA, keyB, surface, round) {
    const [lo, hi] = [String(keyA), String(keyB)].sort();
    const flipped  = lo !== String(keyA);
    return { parts: ['predict-v1', lo, hi, surface || 'any', round || 'any'], flipped };
}

function flipResult(r) {
    return {
        ...r,
        probA: r.probB,
        probB: r.probA,
        // drivers reference player names, not A/B slots, so they stay correct.
    };
}

export async function handlePredict(request, env) {
    const { searchParams } = new URL(request.url);
    const playerKeyA = searchParams.get('playerKeyA');
    const playerKeyB = searchParams.get('playerKeyB');
    const tour       = (searchParams.get('tour') || 'ATP').toUpperCase();
    const surface    = (searchParams.get('surface') || '').toLowerCase() || null;
    const round      = searchParams.get('round') || null;

    // ── Validation → 400 (not 500) ──────────────────────────────────────────
    if (!playerKeyA || !playerKeyB) {
        throw badRequest('playerKeyA and playerKeyB are required');
    }
    if (playerKeyA === playerKeyB) {
        throw badRequest('playerKeyA and playerKeyB must be different');
    }
    if (surface && !['hard', 'clay', 'grass'].includes(surface)) {
        throw badRequest(`Invalid surface: ${surface}. Use hard, clay, or grass.`);
    }
    const surfaceForModel = surface || 'hard'; // default surface for split lookup

    // ── Cache (order-independent) ─────────────────────────────────────────────
    const { parts, flipped } = canonicalCacheParts(playerKeyA, playerKeyB, surface, round);
    const cached = await cache.get(env, ...parts);
    if (cached) {
        return flipped ? flipResult(cached.data) : cached.data;
    }

    // ── Fetch the three signals in parallel, reusing existing handlers ─────────
    const [standings, statsA, statsB, h2h] = await Promise.all([
        callHandler(handleStandings,  `/api/standings?tour=${tour}`, env),
        callHandler(handlePlayerStats, `/api/player-stats?tour=${tour}&playerKey=${playerKeyA}`, env),
        callHandler(handlePlayerStats, `/api/player-stats?tour=${tour}&playerKey=${playerKeyB}`, env),
        callHandler(handleH2H, `/api/h2h?playerKeyA=${playerKeyA}&playerKeyB=${playerKeyB}&tour=${tour}`, env),
    ]);

    // Rank lookup from standings (array of { rank, playerKey, name }).
    const rankList = Array.isArray(standings) ? standings : [];
    const rowA = rankList.find(r => String(r.playerKey) === String(playerKeyA)) || null;
    const rowB = rankList.find(r => String(r.playerKey) === String(playerKeyB)) || null;

    // H2H: surfaceSplits.all is keyed p1 = playerKeyA (the order we requested).
    const allSplit = h2h?.surfaceSplits?.all || null;

    const modelInput = {
        rankA: rowA?.rank ?? null,
        rankB: rowB?.rank ?? null,
        surfaceWinPctA: surfaceFraction(statsA, surfaceForModel),
        surfaceWinPctB: surfaceFraction(statsB, surfaceForModel),
        h2hWinsA: allSplit ? allSplit.p1wins : null,
        h2hWinsB: allSplit ? allSplit.p2wins : null,
        nameA: rowA?.name || statsA?.name || 'Player A',
        nameB: rowB?.name || statsB?.name || 'Player B',
    };

    const result = predict(modelInput);

    // Cache under the canonical (sorted) orientation. If the request was flipped,
    // store the un-flipped (canonical) result and return the flipped view.
    const canonical = flipped ? flipResult(result) : result;
    await cache.set(env, PREDICT_TTL, canonical, ...parts);

    return result;
}
