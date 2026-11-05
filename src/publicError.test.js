import { describe, expect, it } from 'vitest';
import { QuotaStopError } from './quotaStop.js';
import { publicErrorMessage } from './publicError.js';

describe('publicErrorMessage', () => {
    it('keeps short client errors and hides stacks and database text', () => {
        expect(publicErrorMessage(new QuotaStopError())).toBe('Upstream request failed');
        expect(publicErrorMessage(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe('Unauthorized');
        expect(publicErrorMessage(new Error('Invalid tour. Expected ATP or WTA.'))).toBe('Invalid tour. Expected ATP or WTA.');
        expect(publicErrorMessage(new Error('D1_ERROR: near "SELECT": syntax error'))).toBe('Request failed');
        expect(publicErrorMessage(new Error('SQLITE_CONSTRAINT: PRIMARY KEY'))).toBe('Request failed');
        expect(publicErrorMessage(new Error('boom\n    at handleFixtures (fixtures.js:12:4)'))).toBe('Request failed');
        expect(publicErrorMessage(new Error(''))).toBe('Request failed');
        expect(publicErrorMessage(new Error(
            'Failed to fetch https://api.api-tennis.com/tennis/?method=get_tournaments&APIkey=super-secret-tennis-key',
        ))).toBe('Request failed');
    });
});
