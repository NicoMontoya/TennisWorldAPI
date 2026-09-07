import { describe, it, expect } from 'vitest';
import {
    EVENT_TYPES,
    normalizeEventType,
    deriveEventType,
    assignEventType,
} from './eventType.js';

describe('normalizeEventType allowlist', () => {
    it('accepts the canonical set and case/separator variants', () => {
        expect(EVENT_TYPES).toEqual([
            'ATP Singles', 'ATP Doubles', 'WTA Singles', 'WTA Doubles', 'Mixed Doubles',
        ]);
        expect(normalizeEventType('ATP Singles')).toBe('ATP Singles');
        expect(normalizeEventType('atp singles')).toBe('ATP Singles');
        expect(normalizeEventType('Atp Singles')).toBe('ATP Singles');
        expect(normalizeEventType('ATP-Singles')).toBe('ATP Singles');
        expect(normalizeEventType('WTA_Doubles')).toBe('WTA Doubles');
        expect(normalizeEventType('wta doubles')).toBe('WTA Doubles');
    });

    it('maps ATP/WTA Mixed (and bare Mixed) into Mixed Doubles', () => {
        expect(normalizeEventType('Mixed Doubles')).toBe('Mixed Doubles');
        expect(normalizeEventType('ATP Mixed')).toBe('Mixed Doubles');
        expect(normalizeEventType('WTA Mixed')).toBe('Mixed Doubles');
        expect(normalizeEventType('mixed')).toBe('Mixed Doubles');
        expect(normalizeEventType('ATP Mixed Doubles')).toBe('Mixed Doubles');
    });

    it('drops unknown, empty, and lower-tier labels — never pass-through', () => {
        expect(normalizeEventType(null)).toBeNull();
        expect(normalizeEventType('')).toBeNull();
        expect(normalizeEventType('ATP')).toBeNull();
        expect(normalizeEventType('WTA')).toBeNull();
        expect(normalizeEventType('ITF')).toBeNull();
        expect(normalizeEventType('Challenger')).toBeNull();
        expect(normalizeEventType('ATP Challenger')).toBeNull();
        expect(normalizeEventType('ATP Challenger Singles')).toBeNull();
        expect(normalizeEventType('Junior Boys')).toBeNull();
        expect(normalizeEventType('Exhibition')).toBeNull();
        expect(normalizeEventType('M25 Cary')).toBeNull();
        expect(normalizeEventType('W15 Santa Tecla')).toBeNull();
        expect(normalizeEventType('Some Free Text')).toBeNull();
        expect(normalizeEventType('<script>alert(1)</script>')).toBeNull();
    });
});

describe('deriveEventType', () => {
    it('prefers an explicit allowlisted upstream label', () => {
        expect(deriveEventType({
            raw: 'WTA Doubles',
            tour: 'ATP',
            bucket: 'singles',
            player1Name: 'A',
            player2Name: 'B',
        })).toBe('WTA Doubles');
    });

    it('uses Core singles/doubles bucket + validated tour', () => {
        expect(deriveEventType({ tour: 'ATP', bucket: 'singles' })).toBe('ATP Singles');
        expect(deriveEventType({ tour: 'WTA', bucket: 'doubles' })).toBe('WTA Doubles');
    });

    it('uses the in-repo "/" doubles heuristic + validated tour', () => {
        expect(deriveEventType({
            tour: 'ATP',
            player1Name: 'R. Ram / A. Salisbury',
            player2Name: 'M. Ebden / W. Koolhof',
        })).toBe('ATP Doubles');
        expect(deriveEventType({
            tour: 'WTA',
            player1Name: 'C. Gauff',
            player2Name: 'I. Swiatek',
        })).toBe('WTA Singles');
    });

    it('does not invent a category from tour alone', () => {
        expect(deriveEventType({ tour: 'ATP' })).toBeNull();
        expect(deriveEventType({ raw: 'ATP' })).toBeNull();
        expect(deriveEventType({ tour: 'WTA', raw: 'WTA' })).toBeNull();
    });

    it('does not fall through to tour+names when the raw label is rejected', () => {
        expect(deriveEventType({
            raw: 'ATP Challenger',
            tour: 'ATP',
            player1Name: 'A',
            player2Name: 'B',
        })).toBeNull();
        expect(deriveEventType({
            raw: 'ITF',
            tour: 'ATP',
            bucket: 'singles',
        })).toBeNull();
    });

    it('maps MatchStat tourType ATP Singles and doubles:false to ATP Singles', () => {
        expect(deriveEventType({ raw: 'ATP Singles', doubles: false })).toBe('ATP Singles');
        expect(deriveEventType({ raw: 'ATP', tour: 'ATP', doubles: false })).toBe('ATP Singles');
        expect(deriveEventType({ raw: 'ATP', doubles: true })).toBe('ATP Doubles');
    });
});

describe('assignEventType', () => {
    it('omits the field when unknown and never writes a non-allowlisted string', () => {
        const missing = assignEventType({ matchKey: '1' }, { tour: 'ATP' });
        expect(missing).not.toHaveProperty('eventType');

        const junk = assignEventType({ matchKey: '2', eventType: 'stale' }, {
            raw: 'Junior Exhibition',
            tour: 'ATP',
            player1Name: 'A',
            player2Name: 'B',
        });
        expect(junk).not.toHaveProperty('eventType');
        expect(JSON.stringify(junk)).not.toMatch(/Junior|Exhibition|stale/i);

        const ok = assignEventType({ matchKey: '3' }, { tour: 'ATP', bucket: 'singles' });
        expect(ok.eventType).toBe('ATP Singles');
    });
});
