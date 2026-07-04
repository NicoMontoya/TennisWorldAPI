// ===================================
// TennisWorld — Favorites Routes
// ===================================
// GET  /api/favorites         — list current user's favorites
// POST /api/favorites/toggle  — add or remove a player

import { getAuthUser, saveUser } from './auth.js';

export async function handleFavorites(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    return { favorites: user.favorites || [] };
}

export async function handleFavoritesToggle(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });

    const { playerKey, name, country, tour } = await request.json();
    if (!playerKey) throw Object.assign(new Error('playerKey is required'), { status: 400 });

    const favorites = user.favorites || [];
    const idx = favorites.findIndex(f => f.playerKey === String(playerKey));

    if (idx >= 0) {
        favorites.splice(idx, 1);
    } else {
        favorites.push({ playerKey: String(playerKey), name: name || '', country: country || '', tour: tour || '' });
    }

    user.favorites = favorites;
    await saveUser(env, user);
    return { favorites };
}
