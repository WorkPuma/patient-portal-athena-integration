/**
 * Tests for SalesforceClient error parsing helpers.
 *
 * @see src/lib/salesforce/client.ts
 */

import { describe, it, expect } from 'vitest';
import { SalesforceApiError } from './client';

describe('SalesforceApiError', () => {
    it('parses a single SF validation error item', () => {
        const body = JSON.stringify([
            {
                message:
                    'Phone numbers with sequences of the same digit repeated 10 times are not allowed. Please enter a valid phone number.',
                errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                fields: [],
            },
        ]);
        const err = new SalesforceApiError(400, body);

        expect(err.status).toBe(400);
        expect(err.hasCode('FIELD_CUSTOM_VALIDATION_EXCEPTION')).toBe(true);
        expect(err.hasCode('DUPLICATES_DETECTED')).toBe(false);
        expect(err.firstMessage).toBe(
            'Phone numbers with sequences of the same digit repeated 10 times are not allowed. Please enter a valid phone number.',
        );
    });

    it('parses multiple SF error items and returns the first message', () => {
        const body = JSON.stringify([
            { message: 'Duplicate rule fired', errorCode: 'DUPLICATES_DETECTED', fields: ['Email'] },
            { message: 'Phone numbers with sequences of the same digit repeated 10 times are not allowed.', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', fields: [] },
        ]);
        const err = new SalesforceApiError(400, body);

        expect(err.hasCode('DUPLICATES_DETECTED')).toBe(true);
        expect(err.hasCode('FIELD_CUSTOM_VALIDATION_EXCEPTION')).toBe(true);
        expect(err.firstMessage).toBe('Duplicate rule fired');
    });

    it('keeps the legacy `Salesforce API error: <status> - <body>` message shape', () => {
        const err = new SalesforceApiError(404, '[{"message":"Not found","errorCode":"NOT_FOUND"}]');
        expect(err.message).toMatch(/^Salesforce API error: 404 - /);
        expect(err.message).toContain('NOT_FOUND');
    });

    it('falls back to the raw body when SF returns a non-JSON error', () => {
        const err = new SalesforceApiError(502, 'Bad Gateway');
        expect(err.status).toBe(502);
        expect(err.body).toBeNull();
        expect(err.firstMessage).toBeNull();
        expect(err.hasCode('ANYTHING')).toBe(false);
        expect(err.message).toBe('Salesforce API error: 502 - Bad Gateway');
    });

    it('falls back when the parsed body has no errorCode items', () => {
        const err = new SalesforceApiError(500, '{"other": "shape"}');
        expect(err.body).toBeNull();
        expect(err.firstMessage).toBeNull();
    });

    it('is still an instanceof Error', () => {
        const err = new SalesforceApiError(400, '[]');
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('SalesforceApiError');
    });
});
