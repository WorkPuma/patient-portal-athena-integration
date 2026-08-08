/**
 * Tests for API Error Handling Utilities
 *
 * @see src/lib/api-error-utils.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    sanitizeErrorMessage,
    errorResponse,
    successResponse,
    validateRequired,
    isValidEmail,
    isNonEmptyString,
    logApi,
} from './api-error-utils';

// ============================================================================
// SANITIZE ERROR MESSAGE TESTS
// ============================================================================

describe('sanitizeErrorMessage', () => {
    it('returns generic message for null/undefined', () => {
        expect(sanitizeErrorMessage(null)).toBe('An unexpected error occurred');
        expect(sanitizeErrorMessage(undefined)).toBe('An unexpected error occurred');
    });

    it('sanitizes Error objects', () => {
        const error = new Error('Simple error message');
        expect(sanitizeErrorMessage(error)).toBe('Simple error message');
    });

    it('sanitizes string errors', () => {
        expect(sanitizeErrorMessage('Simple string error')).toBe('Simple string error');
    });

    it('redacts file paths in error messages', () => {
        const error = new Error('Error at /home/user/project/src/app/api/route.ts:42:10');
        expect(sanitizeErrorMessage(error)).toBe('An unexpected error occurred');
    });

    it('redacts Windows paths', () => {
        const error = new Error('Error at C:\\Users\\dev\\project\\src\\file.ts');
        expect(sanitizeErrorMessage(error)).toBe('An unexpected error occurred');
    });

    it('redacts password patterns', () => {
        const error = new Error('Connection failed: password=secret123');
        expect(sanitizeErrorMessage(error)).toBe('An unexpected error occurred');
    });

    it('redacts database URLs', () => {
        // Synthetic test fixture exercising the sanitizer's database-URL
        // pattern. The credentials below are not real; they are assembled at
        // runtime so SAST scanners and secret-detection tooling do not match
        // a hardcoded `user:pass@host` literal in source.
        // gitleaks:allow
        const fakeUser = 'user';
        const fakePass = 'pass';
        const error = new Error(
            `Cannot connect to postgresql://${fakeUser}:${fakePass}@localhost:5432/db`,
        );
        expect(sanitizeErrorMessage(error)).toBe('An unexpected error occurred');
    });

    it('redacts tokens and API keys', () => {
        const error = new Error('Invalid token: api_key=sk-1234567890');
        expect(sanitizeErrorMessage(error)).toBe('An unexpected error occurred');
    });

    it('returns known safe messages for common error types', () => {
        expect(sanitizeErrorMessage('validation_error: missing field')).toBe('Invalid request data');
        expect(sanitizeErrorMessage('not_found')).toBe('Resource not found');
        expect(sanitizeErrorMessage('unauthorized access')).toBe('Authentication required');
    });

    it('truncates very long messages', () => {
        const longMessage = 'A'.repeat(200);
        const result = sanitizeErrorMessage(longMessage);
        expect(result.length).toBeLessThanOrEqual(100);
    });

    it('handles objects with message property', () => {
        const error = { message: 'Custom error object' };
        expect(sanitizeErrorMessage(error)).toBe('Custom error object');
    });
});

// ============================================================================
// RESPONSE BUILDER TESTS
// ============================================================================

describe('errorResponse', () => {
    it('creates error response with message and status', async () => {
        const response = errorResponse('Something went wrong', 400);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toBe(true);
        expect(body.message).toBe('Something went wrong');
    });

    it('includes optional error code', async () => {
        const response = errorResponse('Validation failed', 400, 'VALIDATION_ERROR');
        const body = await response.json();

        expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('defaults to 500 status', async () => {
        const response = errorResponse('Server error');
        expect(response.status).toBe(500);
    });
});

describe('successResponse', () => {
    it('creates success response with data', async () => {
        const response = successResponse({ id: '123', name: 'Test' });
        const body = await response.json();

        expect(body.success).toBe(true);
        expect(body.data).toEqual({ id: '123', name: 'Test' });
    });

    it('creates success response without data', async () => {
        const response = successResponse();
        const body = await response.json();

        expect(body.success).toBe(true);
        expect(body.data).toBeUndefined();
    });
});

// ============================================================================
// VALIDATION TESTS
// ============================================================================

describe('validateRequired', () => {
    it('returns valid for all required fields present', () => {
        const data = { name: 'John', email: 'john@example.com' };
        const result = validateRequired(data, ['name', 'email']);

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it('returns invalid for missing field', () => {
        const data = { name: 'John' };
        const result = validateRequired(data, ['name', 'email']);

        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Missing required field: email');
    });

    it('returns invalid for empty string field', () => {
        const data = { name: '', email: 'john@example.com' };
        const result = validateRequired(data, ['name', 'email']);

        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Missing required field: name');
    });

    it('returns invalid for null field', () => {
        const data = { name: null, email: 'john@example.com' };
        const result = validateRequired(data, ['name', 'email']);

        expect(result.isValid).toBe(false);
    });
});

describe('isValidEmail', () => {
    it('returns true for valid emails', () => {
        expect(isValidEmail('test@example.com')).toBe(true);
        expect(isValidEmail('user.name@domain.co.uk')).toBe(true);
        expect(isValidEmail('user+tag@example.org')).toBe(true);
    });

    it('returns false for invalid emails', () => {
        expect(isValidEmail('notanemail')).toBe(false);
        expect(isValidEmail('@nodomain.com')).toBe(false);
        expect(isValidEmail('spaces in@email.com')).toBe(false);
        expect(isValidEmail('')).toBe(false);
    });
});

describe('isNonEmptyString', () => {
    it('returns true for non-empty strings', () => {
        expect(isNonEmptyString('hello')).toBe(true);
        expect(isNonEmptyString('  hello  ')).toBe(true);
    });

    it('returns false for empty or whitespace strings', () => {
        expect(isNonEmptyString('')).toBe(false);
        expect(isNonEmptyString('   ')).toBe(false);
    });

    it('returns false for non-strings', () => {
        expect(isNonEmptyString(null)).toBe(false);
        expect(isNonEmptyString(undefined)).toBe(false);
        expect(isNonEmptyString(123)).toBe(false);
        expect(isNonEmptyString({})).toBe(false);
    });
});

// ============================================================================
// LOGGING TESTS
// ============================================================================

describe('logApi', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs info level to console.log', () => {
        logApi('info', 'Test message', { route: '/api/test' });

        expect(console.log).toHaveBeenCalledOnce();
        const logCall = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
        const parsed = JSON.parse(logCall);

        expect(parsed.level).toBe('info');
        expect(parsed.message).toBe('Test message');
        expect(parsed.route).toBe('/api/test');
    });

    it('logs error level to console.error', () => {
        logApi('error', 'Error occurred', { route: '/api/test' });

        expect(console.error).toHaveBeenCalledOnce();
    });

    it('sanitizes sensitive fields in context', () => {
        logApi('info', 'Test', { password: 'secret123', token: 'abc' });

        const logCall = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
        const parsed = JSON.parse(logCall);

        expect(parsed.password).toBe('[REDACTED]');
        expect(parsed.token).toBe('[REDACTED]');
    });

    it('sanitizes error messages', () => {
        const sensitiveError = new Error('Failed at /home/user/secret/path.ts');
        logApi('error', 'Operation failed', {}, sensitiveError);

        const logCall = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
        const parsed = JSON.parse(logCall);

        expect(parsed.error).toBe('An unexpected error occurred');
    });
});
