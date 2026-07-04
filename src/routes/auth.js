// ===================================
// TennisWorld — Auth Routes
// ===================================
// POST /api/auth/register  — create account
// POST /api/auth/login     — sign in, returns session token
// POST /api/auth/logout    — invalidate session
// GET  /api/auth/me        — current user (requires token)
//
// Storage: uses TENNIS_CACHE KV directly with _user: / _session: prefixes
// so it never collides with the cache module's own key patterns.

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days (seconds)
const enc = new TextEncoder();

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

const RL_MAX    = 10;      // attempts
const RL_WINDOW = 600;     // seconds

async function rateLimit(env, request, bucket) {
    const ip  = request.headers.get('CF-Connecting-IP') || 'local';
    const key = `_rl:${bucket}:${ip}`;
    const n   = parseInt((await env.TENNIS_CACHE.get(key)) || '0', 10) + 1;
    await env.TENNIS_CACHE.put(key, String(n), { expirationTtl: RL_WINDOW });
    if (n > RL_MAX)
        throw Object.assign(new Error('Too many attempts. Please try again in a few minutes.'), { status: 429 });
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function getUser(env, email) {
    return env.TENNIS_CACHE.get(`_user:${email.toLowerCase()}`, 'json');
}

export async function saveUser(env, user) {
    await env.TENNIS_CACHE.put(`_user:${user.email.toLowerCase()}`, JSON.stringify(user));
}

async function getSession(env, token) {
    const s = await env.TENNIS_CACHE.get(`_session:${token}`, 'json');
    if (!s) return null;
    if (Date.now() > s.expiresAt) { await env.TENNIS_CACHE.delete(`_session:${token}`); return null; }
    return s;
}

async function createSession(env, email) {
    const token = crypto.randomUUID();
    await env.TENNIS_CACHE.put(
        `_session:${token}`,
        JSON.stringify({ email, expiresAt: Date.now() + SESSION_TTL * 1000 }),
        { expirationTtl: SESSION_TTL }
    );
    return token;
}

// ── Public: extract authed user from request ──────────────────────────────────

export async function getAuthUser(request, env) {
    const auth  = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    const session = await getSession(env, token);
    if (!session) return null;
    return getUser(env, session.email);
}

function publicUser(u) {
    return {
        firstName: u.firstName,
        lastName:  u.lastName,
        email:     u.email,
        favorites: u.favorites || [],
        createdAt: u.createdAt || null,
    };
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function handleRegister(request, env) {
    await rateLimit(env, request, 'register');
    const { firstName, lastName, email, password } = await request.json();

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password)
        throw Object.assign(new Error('All fields are required'), { status: 400 });
    if (password.length < 6)
        throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400 });

    const emailLow = email.toLowerCase().trim();
    if (await getUser(env, emailLow))
        throw Object.assign(new Error('An account with this email already exists'), { status: 409 });

    const { hash, salt } = await hashPassword(password);
    const user = {
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        email:     emailLow,
        passwordHash: hash,
        salt,
        favorites: [],
        createdAt: Date.now(),
    };
    await saveUser(env, user);
    const token = await createSession(env, emailLow);
    return { token, user: publicUser(user) };
}

export async function handleLogin(request, env) {
    await rateLimit(env, request, 'login');
    const { email, password } = await request.json();
    if (!email?.trim() || !password)
        throw Object.assign(new Error('Email and password are required'), { status: 400 });

    const user = await getUser(env, email.toLowerCase().trim());
    if (!user || !(await verifyPassword(password, user.passwordHash, user.salt)))
        throw Object.assign(new Error('Invalid email or password'), { status: 401 });

    const token = await createSession(env, user.email);
    return { token, user: publicUser(user) };
}

export async function handleLogout(request, env) {
    const auth  = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token) await env.TENNIS_CACHE.delete(`_session:${token}`);
    return { ok: true };
}

export async function handleMe(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    return publicUser(user);
}

export async function handleUpdateProfile(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    const { firstName, lastName } = await request.json();
    if (!firstName?.trim() || !lastName?.trim())
        throw Object.assign(new Error('First and last name are required'), { status: 400 });
    user.firstName = firstName.trim();
    user.lastName  = lastName.trim();
    await saveUser(env, user);
    return publicUser(user);
}

export async function handleChangePassword(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword || !newPassword)
        throw Object.assign(new Error('Current and new password are required'), { status: 400 });
    if (newPassword.length < 6)
        throw Object.assign(new Error('New password must be at least 6 characters'), { status: 400 });
    if (!(await verifyPassword(currentPassword, user.passwordHash, user.salt)))
        throw Object.assign(new Error('Current password is incorrect'), { status: 401 });
    const { hash, salt } = await hashPassword(newPassword);
    user.passwordHash = hash;
    user.salt         = salt;
    await saveUser(env, user);
    return {};
}
