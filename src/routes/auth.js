// ===================================
// TennisWorld — Auth Routes
// ===================================
// POST /api/auth/register          — create account (invite code required)
// POST /api/auth/login             — sign in, sets the session cookie
// POST /api/auth/logout            — clear the session cookie
// POST /api/auth/redeem            — existing account joins with an invite
// GET  /api/auth/me                — current user (cookie)
// POST /api/auth/update-profile    — first/last name, display name
// POST /api/auth/change-password   — rotate password, revoke all sessions
// POST /api/admin/members/revoke   — { email } sets member:false, kills sessions
//
// Cookie sessions live only under `_sess2:`. The old `_session:` prefix is
// never read, so those tokens die on deploy with no bulk delete. Logout
// deletes the `_sess2:` record, not only the cookie. Each login mints a new id.
// The browser sends `__Host-tw_session`. Authorization is ignored.
// Register, redeem, and login share one per-IP rate-limit bucket.

import { requireAdmin } from '../adminAuth.js';
import { consumeInvite, lookupInvite, inviteUsable, INVITE_ERROR } from './invites.js';

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days (seconds)
export const SESSION_MAX_AGE = 2_592_000;
export const SESSION_COOKIE = '__Host-tw_session';
const SESSION_PREFIX = '_sess2:';
const AUTH_BUCKET = 'auth';

export const RATE_LIMIT_ERROR = 'Too many attempts. Try again in a few minutes.';
export const MEMBER_SIGNIN_ERROR = 'Sign in to see this.';
export const MEMBER_ONLY_ERROR = 'This part of TennisWorld is invite-only.';
export const DISPLAY_NAME_ERROR = "Display name must be 1-24 characters (letters, numbers, spaces, and .' -).";

const enc = new TextEncoder();
const cookieJar = new WeakMap();

// Exact paths, plus the families the brief names. A prefix is only used for
// those families (`/api/picks`, `/api/leaderboard`, `/api/me`, `/api/favorites`),
// and only as `path` or `path/...`, so `/api/members` is not `/api/me`.
export const MEMBER_EXACT_ROUTES = [
    '/api/bracket/mine',
    '/api/bracket/save',
    '/api/bracket/leaders',
    '/api/bracket/public',
    '/api/favorites',
    '/api/favorites/toggle',
];

const MEMBER_EXACT = new Set(MEMBER_EXACT_ROUTES);
const MEMBER_FAMILIES = ['/api/picks', '/api/leaderboard', '/api/me', '/api/favorites'];

function httpError(message, status) {
    return Object.assign(new Error(message), { status });
}

function familyMatch(pathname, root) {
    return pathname === root || pathname.startsWith(`${root}/`);
}

export function isMemberRoute(pathname) {
    if (typeof pathname !== 'string') return false;
    if (MEMBER_EXACT.has(pathname)) return true;
    return MEMBER_FAMILIES.some(root => familyMatch(pathname, root));
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function toHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    return bytes;
}

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256
    );
    return { hash: toHex(hash), salt: toHex(salt) };
}

async function verifyPassword(password, hashHex, saltHex) {
    const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: fromHex(saltHex), iterations: 100_000, hash: 'SHA-256' }, key, 256
    );
    return toHex(hash) === hashHex;
}

// ── Rate limiting (best-effort) ───────────────────────────────────────────────
// KV-backed counter per IP per bucket. KV is eventually consistent, so this is
// a soft brake against credential stuffing, not a hard guarantee. Window slides
// on each attempt (TTL reset), which errs on the strict side.
// register, redeem, and login all use the `auth` bucket.

const RL_MAX    = 10;      // attempts
const RL_WINDOW = 600;     // seconds

async function rateLimit(env, request, bucket) {
    const ip  = request.headers.get('CF-Connecting-IP') || 'local';
    const key = `_rl:${bucket}:${ip}`;
    const n   = parseInt((await env.TENNIS_CACHE.get(key)) || '0', 10) + 1;
    await env.TENNIS_CACHE.put(key, String(n), { expirationTtl: RL_WINDOW });
    if (n > RL_MAX) throw httpError(RATE_LIMIT_ERROR, 429);
}

// ── Email / display name ──────────────────────────────────────────────────────

// Looks like local@host.tld — both sides non-empty, no whitespace, exactly one @,
// domain has a dot. Rejects "notanemail", "user@", "@x.com", "a@b".
export function isValidEmail(email) {
    if (typeof email !== 'string') return false;
    const s = email.trim();
    if (!s || s.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function requireEmail(email) {
    if (!isValidEmail(email)) throw httpError('Invalid email address', 400);
    return email.trim().toLowerCase();
}

export function normalizeDisplayName(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().normalize('NFC');
    if (s.length < 1 || s.length > 24) return null;
    if (!/^[\p{L}\p{N} .'\-]+$/u.test(s)) return null;
    return s;
}

function requireDisplayName(raw) {
    const name = normalizeDisplayName(raw);
    if (!name) throw httpError(DISPLAY_NAME_ERROR, 400);
    return name;
}

// ── Cookies ───────────────────────────────────────────────────────────────────
// __Host- cookies: Secure, Path=/, no Domain. The id is opaque. The server
// never reads Authorization for a session.

export function sessionCookie(token) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie() {
    return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function attachCookies(result, cookies) {
    if (result && typeof result === 'object') cookieJar.set(result, cookies);
    return result;
}

export function takeSetCookies(result) {
    if (!result || typeof result !== 'object') return [];
    const cookies = cookieJar.get(result) || [];
    cookieJar.delete(result);
    return cookies;
}

export function readSessionCookie(request) {
    const raw = request.headers.get('Cookie') || '';
    if (!raw) return '';
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const name = part.slice(0, idx).trim();
        if (name !== SESSION_COOKIE) continue;
        const value = part.slice(idx + 1).trim();
        if (!/^[A-Za-z0-9-]{16,80}$/.test(value)) return '';
        return value;
    }
    return '';
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function getUser(env, email) {
    return env.TENNIS_CACHE.get(`_user:${email.toLowerCase()}`, 'json');
}

export async function saveUser(env, user) {
    await env.TENNIS_CACHE.put(`_user:${user.email.toLowerCase()}`, JSON.stringify(user));
}

function sessionKey(token) {
    return `${SESSION_PREFIX}${token}`;
}

async function getSession(env, token) {
    const s = await env.TENNIS_CACHE.get(sessionKey(token), 'json');
    // Only `_sess2:` is read. A record under `_session:` is not a session.
    if (!s || s.v !== 2) return null;
    if (Date.now() > s.expiresAt) {
        await env.TENNIS_CACHE.delete(sessionKey(token));
        return null;
    }
    return s;
}

async function pruneSessions(env, sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return [];
    const live = [];
    for (const token of sessions) {
        const s = await env.TENNIS_CACHE.get(sessionKey(token), 'json');
        if (s && s.v === 2 && Date.now() <= s.expiresAt) live.push(token);
        else if (s) await env.TENNIS_CACHE.delete(sessionKey(token));
    }
    return live;
}

async function createSession(env, email) {
    const token = crypto.randomUUID();
    await env.TENNIS_CACHE.put(
        sessionKey(token),
        JSON.stringify({ v: 2, email, expiresAt: Date.now() + SESSION_TTL * 1000 }),
        { expirationTtl: SESSION_TTL }
    );
    const user = await getUser(env, email);
    if (user) {
        const sessions = await pruneSessions(env, user.sessions);
        sessions.push(token);
        user.sessions = sessions;
        await saveUser(env, user);
    }
    return token;
}

export async function revokeAllSessions(env, user) {
    const sessions = Array.isArray(user.sessions) ? user.sessions : [];
    await Promise.all(sessions.map(t => env.TENNIS_CACHE.delete(sessionKey(t))));
    user.sessions = [];
}

async function dropSessionFromUser(env, email, token) {
    const user = await getUser(env, email);
    if (!user || !Array.isArray(user.sessions)) return;
    const next = user.sessions.filter(t => t !== token);
    if (next.length === user.sessions.length) return;
    user.sessions = next;
    await saveUser(env, user);
}

// ── Public: extract authed user from request ──────────────────────────────────
// Cookie only. Authorization is intentionally unread.

export async function getAuthUser(request, env) {
    const token = readSessionCookie(request);
    if (!token) return null;
    const session = await getSession(env, token);
    if (!session) return null;
    return getUser(env, session.email);
}

export async function assertMember(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw httpError(MEMBER_SIGNIN_ERROR, 401);
    if (user.member !== true) throw httpError(MEMBER_ONLY_ERROR, 403);
    return user;
}

export function publicUser(u) {
    return {
        firstName: u.firstName,
        lastName:  u.lastName,
        email:     u.email,
        favorites: u.favorites || [],
        createdAt: u.createdAt || null,
        displayName: u.displayName || null,
        member: u.member === true,
        memberSince: u.memberSince || null,
    };
}

async function readJson(request) {
    try {
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw httpError('Invalid JSON', 400);
        }
        return body;
    } catch (err) {
        if (err.status) throw err;
        throw httpError('Invalid JSON', 400);
    }
}

function inviteFailed() {
    throw httpError(INVITE_ERROR, 400);
}

async function requireUsableInvite(env, rawCode) {
    const found = await lookupInvite(env, rawCode);
    if (!found || !inviteUsable(found.record)) inviteFailed();
    return found;
}

function memberFields(now) {
    return { member: true, memberSince: now };
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function handleRegister(request, env) {
    await rateLimit(env, request, AUTH_BUCKET);
    const body = await readJson(request);
    const { firstName, lastName, email, password, inviteCode } = body;

    // Code first, then an existing email. Both failures are the same 400 so
    // the form cannot be used to test codes or addresses. The code is not
    // consumed until the account is actually written.
    const found = await requireUsableInvite(env, inviteCode);
    const emailLow = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (emailLow && isValidEmail(emailLow) && await getUser(env, emailLow)) inviteFailed();

    // The Me invite form sends inviteCode, firstName, email, and password.
    // lastName is accepted when present and otherwise stored blank.
    if (!firstName?.trim() || !email?.trim() || !password)
        throw httpError('All fields are required', 400);
    const normalizedEmail = requireEmail(email);
    if (password.length < 6) throw httpError('Password must be at least 6 characters', 400);
    const displayName = requireDisplayName(
        body.displayName == null || body.displayName === '' ? firstName : body.displayName
    );
    if (await getUser(env, normalizedEmail)) inviteFailed();

    const { hash, salt } = await hashPassword(password);
    if (!await consumeInvite(env, found.hash)) inviteFailed();
    const now = Date.now();
    const user = {
        firstName: firstName.trim(),
        lastName:  typeof lastName === 'string' ? lastName.trim() : '',
        displayName,
        email:     normalizedEmail,
        passwordHash: hash,
        salt,
        favorites: [],
        sessions:  [],
        createdAt: now,
        ...memberFields(now),
    };
    await saveUser(env, user);
    const token = await createSession(env, normalizedEmail);
    return attachCookies({ user: publicUser(user) }, [sessionCookie(token)]);
}

export async function handleLogin(request, env) {
    await rateLimit(env, request, AUTH_BUCKET);
    const { email, password } = await readJson(request);
    if (!email?.trim() || !password) throw httpError('Email and password are required', 400);
    const emailLow = requireEmail(email);

    const user = await getUser(env, emailLow);
    if (!user || !(await verifyPassword(password, user.passwordHash, user.salt)))
        throw httpError('Invalid email or password', 401);

    const token = await createSession(env, user.email);
    const fresh = await getUser(env, user.email);
    return attachCookies({ user: publicUser(fresh || user) }, [sessionCookie(token)]);
}

export async function handleLogout(request, env) {
    const token = readSessionCookie(request);
    if (token) {
        const session = await getSession(env, token);
        // Drop the server record. Clearing the cookie alone would leave it live.
        await env.TENNIS_CACHE.delete(sessionKey(token));
        if (session?.email) await dropSessionFromUser(env, session.email, token);
    }
    return attachCookies({ ok: true }, [clearSessionCookie()]);
}

export async function handleRedeem(request, env) {
    await rateLimit(env, request, AUTH_BUCKET);
    const user = await getAuthUser(request, env);
    if (!user) throw httpError(MEMBER_SIGNIN_ERROR, 401);
    const { inviteCode } = await readJson(request);
    const found = await requireUsableInvite(env, inviteCode);
    if (!await consumeInvite(env, found.hash)) inviteFailed();
    const latest = await getUser(env, user.email) || user;
    if (latest.member !== true) {
        latest.member = true;
        latest.memberSince = Date.now();
    }
    await saveUser(env, latest);
    return { user: publicUser(latest) };
}

export async function handleMe(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw httpError('Unauthorized', 401);
    return publicUser(user);
}

// Cookie session. `{displayName}` alone is the Me edit. A bad name is 400
// with DISPLAY_NAME_ERROR. The worker also requires a same-origin Origin on
// this POST. The body is the updated publicUser.
export async function handleUpdateProfile(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw httpError('Unauthorized', 401);
    const body = await readJson(request);
    const hasNames = !!(body.firstName?.trim() && body.lastName?.trim());
    const hasDisplay = typeof body.displayName === 'string';
    if (!hasNames && !hasDisplay) throw httpError('First and last name are required', 400);
    if (body.firstName != null || body.lastName != null) {
        if (!hasNames) throw httpError('First and last name are required', 400);
        user.firstName = body.firstName.trim();
        user.lastName  = body.lastName.trim();
    }
    if (hasDisplay) user.displayName = requireDisplayName(body.displayName);
    await saveUser(env, user);
    return publicUser(user);
}

export async function handleChangePassword(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw httpError('Unauthorized', 401);
    const { currentPassword, newPassword } = await readJson(request);
    if (!currentPassword || !newPassword)
        throw httpError('Current and new password are required', 400);
    if (newPassword.length < 6)
        throw httpError('New password must be at least 6 characters', 400);
    if (!(await verifyPassword(currentPassword, user.passwordHash, user.salt)))
        throw httpError('Current password is incorrect', 401);
    const { hash, salt } = await hashPassword(newPassword);
    user.passwordHash = hash;
    user.salt         = salt;
    // Re-read sessions after the slow hash so a login during PBKDF2 is still revoked.
    const latest = await getUser(env, user.email);
    if (Array.isArray(latest?.sessions)) user.sessions = latest.sessions;
    await revokeAllSessions(env, user);
    const current = readSessionCookie(request);
    if (current) await env.TENNIS_CACHE.delete(sessionKey(current));
    await saveUser(env, user);
    return attachCookies({}, [clearSessionCookie()]);
}

// Admin. Email is in the body, never the URL. member:false and every session dies.
export async function handleAdminRevokeMember(request, env) {
    requireAdmin(request, env);
    const body = await readJson(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isValidEmail(email)) throw httpError('Invalid email address', 400);
    const user = await getUser(env, email);
    if (!user) throw httpError('No such account', 404);
    user.member = false;
    const latest = await getUser(env, email);
    if (Array.isArray(latest?.sessions)) user.sessions = latest.sessions;
    await revokeAllSessions(env, user);
    await saveUser(env, user);
    return { revoked: true };
}
