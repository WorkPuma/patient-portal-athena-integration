/**
 * @fileoverview Tests for utility functions
 *
 * High-impact tests for commonly used utilities across the app
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cn, isServer, isBuilderPreview, buildCanonicalUrl, getSiteBaseUrl } from './utils';

// ============================================================================
// CN (CLASS NAME UTILITY) TESTS
// ============================================================================

describe('cn (className utility)', () => {
    it('combines multiple class names', () => {
        const result = cn('class1', 'class2', 'class3');
        expect(result).toBe('class1 class2 class3');
    });

    it('handles undefined and null values', () => {
        const result = cn('class1', undefined, null, 'class2');
        expect(result).toBe('class1 class2');
    });

    it('handles conditional classes', () => {
        const isActive = true;
        const isDisabled = false;
        const result = cn('base', isActive && 'active', isDisabled && 'disabled');
        expect(result).toBe('base active');
    });

    it('merges conflicting Tailwind classes', () => {
        const result = cn('px-4', 'px-8');
        expect(result).toBe('px-8');
    });

    it('handles empty inputs', () => {
        const result = cn();
        expect(result).toBe('');
    });

    it('handles array of classes', () => {
        const result = cn(['class1', 'class2'], 'class3');
        expect(result).toBe('class1 class2 class3');
    });

    it('handles object syntax for conditional classes', () => {
        const result = cn({
            'always-present': true,
            'conditionally-present': true,
            'never-present': false,
        });
        expect(result).toContain('always-present');
        expect(result).toContain('conditionally-present');
        expect(result).not.toContain('never-present');
    });
});

// ============================================================================
// IS SERVER TESTS
// ============================================================================

describe('isServer', () => {
    it('returns false in jsdom environment (simulating browser)', () => {
        // In jsdom/vitest environment, window is defined
        expect(isServer).toBe(false);
    });
});

// ============================================================================
// IS BUILDER PREVIEW TESTS
// ============================================================================

describe('isBuilderPreview', () => {
    let originalSearch: string;

    beforeEach(() => {
        // Store original search value
        originalSearch = window.location.search;
    });

    afterEach(() => {
        // Restore by redefining with original search
        Object.defineProperty(window, 'location', {
            value: { ...window.location, search: originalSearch },
            writable: true,
            configurable: true,
        });
    });

    it('returns true when builder.preview is in URL', () => {
        Object.defineProperty(window, 'location', {
            value: { search: '?builder.preview=true' },
            writable: true,
            configurable: true,
        });
        expect(isBuilderPreview()).toBe(true);
    });

    it('returns false when builder.preview is not in URL', () => {
        Object.defineProperty(window, 'location', {
            value: { search: '?foo=bar' },
            writable: true,
            configurable: true,
        });
        expect(isBuilderPreview()).toBe(false);
    });

    it('returns false when search is empty', () => {
        Object.defineProperty(window, 'location', {
            value: { search: '' },
            writable: true,
            configurable: true,
        });
        expect(isBuilderPreview()).toBe(false);
    });
});

// ============================================================================
// BUILD CANONICAL URL TESTS
// ============================================================================

describe('buildCanonicalUrl', () => {
    it('builds URL with base and path', () => {
        const result = buildCanonicalUrl('https://example.com', 'about');
        expect(result).toBe('https://example.com/about');
    });

    it('handles path with leading slash', () => {
        const result = buildCanonicalUrl('https://example.com', '/about');
        expect(result).toBe('https://example.com/about');
    });

    it('handles base URL with trailing slash', () => {
        const result = buildCanonicalUrl('https://example.com/', 'about');
        expect(result).toBe('https://example.com/about');
    });

    it('handles both trailing and leading slashes', () => {
        const result = buildCanonicalUrl('https://example.com/', '/about/');
        expect(result).toBe('https://example.com/about/');
    });

    it('returns base URL for empty path', () => {
        const result = buildCanonicalUrl('https://example.com');
        expect(result).toBe('https://example.com');
    });

    it('returns base URL for undefined path', () => {
        const result = buildCanonicalUrl('https://example.com', undefined);
        expect(result).toBe('https://example.com');
    });

    it('removes double slashes in path', () => {
        const result = buildCanonicalUrl('https://example.com', 'about//us');
        expect(result).toBe('https://example.com/about/us');
    });

    it('handles nested paths', () => {
        const result = buildCanonicalUrl('https://example.com', 'blog/posts/my-article');
        expect(result).toBe('https://example.com/blog/posts/my-article');
    });

    it('handles path with multiple leading slashes', () => {
        const result = buildCanonicalUrl('https://example.com', '///about');
        expect(result).toBe('https://example.com/about');
    });

    it('handles base URL with multiple trailing slashes', () => {
        const result = buildCanonicalUrl('https://example.com///', 'about');
        expect(result).toBe('https://example.com/about');
    });
});

// ============================================================================
// GET SITE BASE URL TESTS
// ============================================================================

describe('getSiteBaseUrl', () => {
    const originalEnv = process.env.NEXT_PUBLIC_SITE_URL;

    afterEach(() => {
        // Restore original environment
        if (originalEnv !== undefined) {
            process.env.NEXT_PUBLIC_SITE_URL = originalEnv;
        } else {
            delete process.env.NEXT_PUBLIC_SITE_URL;
        }
    });

    it('returns environment variable when set', () => {
        process.env.NEXT_PUBLIC_SITE_URL = 'https://custom-domain.com';
        const result = getSiteBaseUrl();
        expect(result).toBe('https://custom-domain.com');
    });

    it('returns default URL when environment variable is not set', () => {
        delete process.env.NEXT_PUBLIC_SITE_URL;
        const result = getSiteBaseUrl();
        expect(result).toBe('https://example-patient-portal.com');
    });

    it('returns default URL when environment variable is empty', () => {
        process.env.NEXT_PUBLIC_SITE_URL = '';
        const result = getSiteBaseUrl();
        expect(result).toBe('https://example-patient-portal.com');
    });
});
