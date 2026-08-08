/**
 * API Error Handling Utilities
 *
 * Implements Next.js code review best practices for secure error handling:
 * - Sanitize error messages to prevent sensitive data leakage
 * - Provide consistent error response structure
 * - Validate incoming request data
 *
 * @see https://awesomereviewers.com/reviewers/nextjs-proper-error-handling-in-nextjs-api-routes/
 */

import { NextResponse } from 'next/server';
import {
    captureServerException,
    captureServerMessage,
} from '@/lib/capture-exception';

// ============================================================================
// TYPES
// ============================================================================

export interface ApiErrorResponse {
    error: true;
    message: string;
    code?: string;
}

export interface ApiSuccessResponse<T = unknown> {
    success: true;
    data?: T;
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

// ============================================================================
// ERROR SANITIZATION
// ============================================================================

/**
 * Patterns that indicate sensitive information that should be redacted
 */
const SENSITIVE_PATTERNS = [
    // File paths and stack traces
    /at\s+[\w.]+\s+\([^)]+\)/g,                    // Stack trace lines
    /\/[\w/-]+\.(ts|js|tsx|jsx):\d+:\d+/g,         // File paths with line numbers
    /[A-Z]:\\[\w\\/-]+/gi,                          // Windows paths
    /\/home\/[\w/-]+/g,                             // Unix home paths
    /\/var\/[\w/-]+/g,                              // Unix var paths

    // Credentials and tokens
    /password[=:]\s*['"]?[\w!@#$%^&*]+['"]?/gi,
    /token[=:]\s*['"]?[\w.-]+['"]?/gi,
    /api[_-]?key[=:]\s*['"]?[\w.-]+['"]?/gi,
    /secret[=:]\s*['"]?[\w.-]+['"]?/gi,
    /authorization:\s*bearer\s+[\w.-]+/gi,

    // Database/infrastructure details
    /postgresql:\/\/[\w:@./-]+/gi,
    /mongodb:\/\/[\w:@./-]+/gi,
    /redis:\/\/[\w:@./-]+/gi,
    /localhost:\d+/g,
    /127\.0\.0\.1:\d+/g,
];

/**
 * Known error messages that are safe to pass through
 */
const SAFE_ERROR_MESSAGES: Record<string, string> = {
    'validation_error': 'Invalid request data',
    'not_found': 'Resource not found',
    'unauthorized': 'Authentication required',
    'forbidden': 'Access denied',
    'rate_limit': 'Too many requests, please try again later',
    'server_error': 'An unexpected error occurred',
};

/**
 * Sanitize an error message to prevent sensitive data leakage
 *
 * @param error - The error to sanitize (can be Error, string, or unknown)
 * @returns A safe error message suitable for client responses
 */
export function sanitizeErrorMessage(error: unknown): string {
    // Handle null/undefined
    if (error === null || error === undefined) {
        return SAFE_ERROR_MESSAGES['server_error'];
    }

    // Extract message string
    let message: string;
    if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === 'string') {
        message = error;
    } else if (typeof error === 'object' && 'message' in error) {
        message = String((error as { message: unknown }).message);
    } else {
        return SAFE_ERROR_MESSAGES['server_error'];
    }

    // Check for known safe messages
    const lowerMessage = message.toLowerCase();
    for (const [key, safeMessage] of Object.entries(SAFE_ERROR_MESSAGES)) {
        if (lowerMessage.includes(key)) {
            return safeMessage;
        }
    }

    // Redact sensitive patterns
    let sanitized = message;
    for (const pattern of SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
    }

    // If message was significantly changed, return generic error
    if (sanitized.includes('[REDACTED]') || sanitized.length > 200) {
        return SAFE_ERROR_MESSAGES['server_error'];
    }

    // Return sanitized message (truncated if too long)
    return sanitized.slice(0, 100);
}

// ============================================================================
// RESPONSE BUILDERS
// ============================================================================

/**
 * Create a standardized error response
 *
 * @param message - User-facing error message
 * @param status - HTTP status code
 * @param code - Optional error code for client handling
 */
export function errorResponse(
    message: string,
    status: number = 500,
    code?: string
): NextResponse<ApiErrorResponse> {
    return NextResponse.json(
        {
            error: true,
            message,
            ...(code && { code }),
        },
        { status }
    );
}

/**
 * Create a standardized success response
 *
 * @param data - Response data
 */
export function successResponse<T>(data?: T): NextResponse<ApiSuccessResponse<T>> {
    return NextResponse.json({
        success: true,
        ...(data !== undefined && { data }),
    });
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate that required fields are present and non-empty
 *
 * @param data - The data object to validate
 * @param fields - Array of required field names
 * @returns Object with isValid flag and optional error message
 */
export function validateRequired(
    data: Record<string, unknown>,
    fields: string[]
): { isValid: boolean; error?: string } {
    for (const field of fields) {
        const value = data[field];
        if (value === undefined || value === null || value === '') {
            return {
                isValid: false,
                error: `Missing required field: ${field}`,
            };
        }
    }
    return { isValid: true };
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Validate that a value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
    route?: string;
    method?: string;
    [key: string]: unknown;
}

/**
 * Log with structured context (sanitizes sensitive data) and forward
 * `error`/`warn` levels to Sentry so legacy routes that catch+respond instead
 * of throwing still surface in our error tracker.
 */
export function logApi(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: unknown
): void {
    const timestamp = new Date().toISOString();
    const sanitizedContext = context ? { ...context } : {};

    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'authorization'];
    for (const key of sensitiveKeys) {
        if (key in sanitizedContext) {
            sanitizedContext[key] = '[REDACTED]';
        }
    }

    const logEntry: Record<string, unknown> = {
        timestamp,
        level,
        message,
        ...sanitizedContext,
    };

    if (error) {
        logEntry.error = sanitizeErrorMessage(error);
    }

    switch (level) {
        case 'error':
            console.error(JSON.stringify(logEntry));
            forwardToSentry('error', message, sanitizedContext, error);
            break;
        case 'warn':
            console.warn(JSON.stringify(logEntry));
            forwardToSentry('warning', message, sanitizedContext, error);
            break;
        case 'debug':
            if (process.env.NODE_ENV === 'development') {
                console.debug(JSON.stringify(logEntry));
            }
            break;
        default:
            console.log(JSON.stringify(logEntry));
    }
}

type SentrySeverity = 'error' | 'warning';

function forwardToSentry(
    severity: SentrySeverity,
    message: string,
    context: Record<string, unknown>,
    error: unknown
): void {
    const route = typeof context.route === 'string' ? context.route : 'unknown';
    const method = typeof context.method === 'string' ? context.method : undefined;
    const tags = {
        api_route: route,
        ...(method ? { http_method: method } : {}),
    };
    const extra = { ...context, message };

    if (error instanceof Error) {
        captureServerException(error, { level: severity, tags, extra });
        return;
    }

    if (error !== undefined && error !== null) {
        captureServerException(new Error(`${message}: ${String(error)}`), {
            level: severity,
            tags,
            extra,
        });
        return;
    }

    captureServerMessage(message, { level: severity, tags, extra });
}
