// POST /api/admin/backfill-last-good
// Body: { resource: "fixtures"|"standings"|"calendar"|"draws", tour, page?, tournamentKey?, year? }
// One capped batch per call. x-admin-secret, fail closed when unset.
// Does not walk the whole feed — the caller repeats with nextPage.

import { rapidAPI } from '../apiClient.js';
import { cache } from '../cache.js';
import { requireAdmin } from '../adminAuth.js';
import { calendarYearInWindow } from '../calendarYear.js';
import { parseTour, parseTournamentKey } from '../security.js';
import { normalizeFixturesFeed } from '../transforms/fixturesFeed.js';
import { readAsOf } from '../asOf.js';
import {
    d1BackfillBatch,
    d1WritesRemaining,
    readDraw,
    rememberFixtures,
    rememberStandings,
    rememberTournaments,
} from '../d1Store.js';
import { mapStandings } from './standings.js';
import { handleDraws } from './draws.js';
import { DRAWS_CACHE_RESOURCE } from '../officialDraw.js';
import { isQuotaStop } from '../quotaStop.js';

function httpError(status, message) {
    throw Object.assign(new Error(message), { status });
}

function pageNumber(raw) {
    if (raw == null || raw === '') return 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 20) httpError(400, 'Invalid page');
    return n;
}

export async function handleBackfillLastGood(request, env) {
    requireAdmin(request, env);
    if (!env?.DB || typeof env.DB.prepare !== 'function') httpError(503, 'Request failed');

    let body;
    try {
        body = await request.json();
    } catch {
        httpError(400, 'Invalid JSON');
    }
    if (!body || typeof body !== 'object') httpError(400, 'Invalid JSON');

    const resource = String(body.resource || '').trim().toLowerCase();
    const tour = parseTour(body.tour);
    const cap = d1BackfillBatch(env);
    const page = pageNumber(body.page);

    try {
        if (resource === 'fixtures') return await backfillFixtures(env, body, tour, cap, page);
        if (resource === 'standings') return await backfillStandings(env, tour, cap);
        if (resource === 'calendar') return await backfillCalendar(env, body, tour, cap, page);
        if (resource === 'draws') return await backfillDraws(env, body, tour);
    } catch (err) {
        if (isQuotaStop(err) || err?.status) throw err;
        httpError(502, 'Upstream request failed');
    }
    httpError(400, 'Invalid resource');
}

function budgetStopped(resource, tour, extra = {}) {
    return { ok: true, resource, tour, written: 0, capped: true, budget: true, ...extra };
}

async function backfillFixtures(env, body, tour, cap, page) {
    const tournamentKey = parseTournamentKey(body.tournamentKey);
    if (await d1WritesRemaining(env) <= 0) return budgetStopped('fixtures', tour, { nextPage: null });
    let raw;
    if (tournamentKey) {
        raw = await rapidAPI.tournamentFixtures(env, tour, tournamentKey);
    } else {
        raw = await rapidAPI.fixturesFeed(env, tour, { pageNo: page, pageSize: cap });
    }
    const normalized = normalizeFixturesFeed(raw, { tour, tournamentKey });
    const rows = normalized.slice(0, cap);
    const saved = await rememberFixtures(env, tour, rows);
    const more = normalized.length > cap || raw?.hasNextPage === true;
    return {
        ok: true,
        resource: 'fixtures',
        tour,
        written: saved.written || 0,
        capped: true,
        budget: saved.budget === true,
        nextPage: tournamentKey ? null : (more ? page + 1 : null),
    };
}

async function backfillStandings(env, tour, cap) {
    if (await d1WritesRemaining(env) <= 0) return budgetStopped('standings', tour);
    const raw = await rapidAPI.rankings(env, tour, cap);
    const rows = mapStandings(raw?.data || [], tour).slice(0, cap);
    const saved = await rememberStandings(env, tour, rows, { replace: false });
    return {
        ok: true,
        resource: 'standings',
        tour,
        written: saved.written || 0,
        capped: true,
        budget: saved.budget === true,
    };
}

async function backfillCalendar(env, body, tour, cap, page) {
    const year = calendarYearInWindow(body.year ?? new Date().getFullYear());
    if (!year) httpError(400, 'Invalid year. Expected the current year ±1.');
    if (await d1WritesRemaining(env) <= 0) return budgetStopped('calendar', tour, { year, nextPage: null });
    const raw = await rapidAPI.calendarPage(env, tour, year, page, cap);
    const items = (Array.isArray(raw?.data) ? raw.data : []).slice(0, cap);
    const saved = await rememberTournaments(env, tour, items, { replace: false });
    const more = (raw?.data?.length || 0) >= cap;
    return {
        ok: true,
        resource: 'calendar',
        tour,
        year,
        written: saved.written || 0,
        capped: true,
        budget: saved.budget === true,
        nextPage: more ? page + 1 : null,
    };
}

async function backfillDraws(env, body, tour) {
    const tournamentKey = parseTournamentKey(body.tournamentKey, { required: true });
    if (await d1WritesRemaining(env) <= 0) {
        return budgetStopped('draws', tour, { tournamentKey });
    }
    const before = await readDraw(env, tour, tournamentKey);
    try {
        await cache.invalidate(env, DRAWS_CACHE_RESOURCE, tournamentKey, tour);
    } catch { /* a hot edge entry just means this batch may no-op */ }
    const data = await handleDraws(
        new Request(`https://tennisworld.internal/api/draws?tour=${tour}&tournamentKey=${tournamentKey}`),
        env,
    );
    const after = await readDraw(env, tour, tournamentKey);
    const wrote = !!(after && (!before || before.asOf !== after.asOf));
    return {
        ok: true,
        resource: 'draws',
        tour,
        tournamentKey,
        written: wrote ? 1 : 0,
        capped: true,
        asOf: readAsOf(data) || null,
    };
}
