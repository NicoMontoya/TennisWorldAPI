// Client-facing error text. Short and generic. Never a stack, SQL fragment,
// or D1/SQLite diagnostic. Callers still attach err.status themselves.

import { isQuotaStop } from './quotaStop.js';

export function publicErrorMessage(err) {
    if (isQuotaStop(err)) return 'Upstream request failed';
    const message = typeof err?.message === 'string' ? err.message.trim() : '';
    if (!message) return 'Request failed';
    if (message.length > 180) return 'Request failed';
    if (/[\r\n]/.test(message)) return 'Request failed';
    if (/\bat\s+.+:\d+/.test(message)) return 'Request failed';
    if (/SQLITE|D1_|syntax error|\bstack\b/i.test(message)) return 'Request failed';
    // TENNIS_API_KEY is a query param on the API-Tennis URL. Never echo that URL.
    if (/api\.api-tennis\.com|APIkey=|TENNIS_API_KEY|RAPIDAPI_KEY|X-RapidAPI-Key/i.test(message)) {
        return 'Request failed';
    }
    return message;
}
