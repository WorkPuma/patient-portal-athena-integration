/**
 * Rate Limiting Utility
 * 
 * Provides rate limiting for API routes to prevent abuse.
 * Priority order:
 * 1. Upstash Redis (if configured) - fastest, recommended for production
 * 2. Supabase PostgreSQL (if configured) - good for moderate traffic
 * 3. In-memory (fallback) - for development only
 * 
 * Configuration via environment variables:
 * - UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN: Upstash Redis
 * - SUPABASE_SERVICE_ROLE_KEY & NEXT_PUBLIC_SUPABASE_URL: Supabase PostgreSQL
 * 
 * Usage:
 * ```typescript
 * import { rateLimit, RateLimitResult } from '@/lib/rate-limit';
 * 
 * export async function POST(request: NextRequest) {
 *   const result = await rateLimit(request, { limit: 10, window: '1m' });
 *   if (!result.success) {
 *     return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
 *   }
 *   // ... handle request
 * }
 * ```
 */

import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";

// Lazy-initialized Supabase client
let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;

  // `readSupabaseEnv` defends against the `vercel env pull` `\r\n`
  // artifact that would otherwise silently break every rate-limit
  // bucket lookup.
  const env = readSupabaseEnv({ role: "service-role" });
  if (!env) return null;

  supabaseClient = createClient(env.url, env.key, {
    auth: { persistSession: false },
  });

  return supabaseClient;
}

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Time window (e.g., '1m', '1h', '1d') */
  window: string;
  /** Optional identifier prefix for the rate limit key */
  prefix?: string;
  /**
   * When set, rate-limit on this string instead of the client IP.
   * Used by `/api/portal/register/patient` so Dot's server-to-server
   * calls (which would otherwise share one synthetic IP) are bucketed
   * per mobile number instead of globally starving all chat sessions.
   */
  identifierOverride?: string;
  /**
   * Fail-closed mode for sensitive endpoints (registration, handoff, DOB
   * verify, Retell chat). When true, if every distributed limiter (Upstash,
   * then Supabase) is unavailable, the request is DENIED instead of falling
   * back to the non-distributed in-memory limiter. In-memory is still used as
   * the last resort for non-failClosed callers (dev / low-stakes endpoints).
   */
  failClosed?: boolean;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

// In-memory store for development/fallback
const inMemoryStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Parse window string to milliseconds
 */
function parseWindow(window: string): number {
  const match = window.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid window format: ${window}. Use format like '1m', '1h', '1d'`);
  }
  
  const value = parseInt(match[1], 10);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}

/**
 * Get client identifier from request
 */
function getClientId(request: NextRequest): string {
  // Try to get IP from various headers (Vercel, Cloudflare, etc.)
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  
  // Use the first available IP, or fall back to a default
  const ip = forwarded?.split(",")[0]?.trim() || 
             realIp || 
             cfConnectingIp || 
             "anonymous";
  
  return ip;
}

/**
 * In-memory rate limiter (for development or when Redis is not configured)
 */
async function inMemoryRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const windowMs = parseWindow(config.window);
  const now = Date.now();
  const key = `${config.prefix || "rl"}:${identifier}`;
  
  // Clean up expired entries periodically
  if (Math.random() < 0.01) {
    Array.from(inMemoryStore.entries()).forEach(([k, v]) => {
      if (v.resetTime < now) {
        inMemoryStore.delete(k);
      }
    });
  }
  
  const existing = inMemoryStore.get(key);
  
  if (!existing || existing.resetTime < now) {
    // First request or window expired
    inMemoryStore.set(key, { count: 1, resetTime: now + windowMs });
    return {
      success: true,
      limit: config.limit,
      remaining: config.limit - 1,
      reset: now + windowMs,
    };
  }
  
  if (existing.count >= config.limit) {
    return {
      success: false,
      limit: config.limit,
      remaining: 0,
      reset: existing.resetTime,
    };
  }
  
  existing.count++;
  return {
    success: true,
    limit: config.limit,
    remaining: config.limit - existing.count,
    reset: existing.resetTime,
  };
}

/**
 * Upstash Redis rate limiter
 */
async function upstashRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const { Ratelimit } = await import("@upstash/ratelimit");
  const { Redis } = await import("@upstash/redis");
  
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  
  // Parse window to create appropriate limiter
  const windowMs = parseWindow(config.window);
  const windowSec = Math.ceil(windowMs / 1000);
  
  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(config.limit, `${windowSec} s`),
    prefix: config.prefix || "rl",
  });
  
  const result = await ratelimit.limit(identifier);
  
  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}

/**
 * Supabase PostgreSQL rate limiter
 * Uses the hhv2.check_rate_limit() function for atomic operations
 */
async function supabaseRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase client not available");
  }
  
  // Parse window to seconds
  const windowMs = parseWindow(config.window);
  const windowSec = Math.ceil(windowMs / 1000);
  
  const { data, error } = await supabase.rpc("check_rate_limit", {
    p_identifier: identifier,
    p_prefix: config.prefix || "rl",
    p_limit: config.limit,
    p_window_seconds: windowSec,
  });
  
  if (error) {
    throw new Error(`Supabase rate limit error: ${error.message}`);
  }
  
  // The function returns an array with one row
  const result = data?.[0];
  if (!result) {
    throw new Error("No result from rate limit function");
  }
  
  return {
    success: result.success,
    limit: config.limit,
    remaining: result.remaining,
    reset: new Date(result.reset_at).getTime(),
  };
}

/**
 * Rate limit a request
 * 
 * Priority order:
 * 1. Upstash Redis (fastest, best for high-traffic production)
 * 2. Supabase PostgreSQL (good for moderate traffic, uses hhv2 schema)
 * 3. In-memory (development fallback only - not distributed)
 * 
 * @param request - The Next.js request object
 * @param config - Rate limit configuration
 * @returns Rate limit result with success status and metadata
 */
export async function rateLimit(
  request: NextRequest,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  // E2E test bypass. Production never accepts the bypass header even if a
  // token were leaked, so the worst case is "we don't rate limit one of our
  // own staging runs". The token is required on every request — there is no
  // implicit allowlist.
  const bypassToken = process.env.E2E_RATE_LIMIT_BYPASS_TOKEN;
  const incomingToken = request.headers.get("x-e2e-bypass-token");
  const vercelEnv = process.env.VERCEL_ENV;
  if (
    bypassToken &&
    incomingToken === bypassToken &&
    vercelEnv !== "production"
  ) {
    const now = Date.now();
    return {
      success: true,
      limit: config.limit,
      remaining: config.limit,
      reset: now + 60_000,
    };
  }

  const identifier =
    config.identifierOverride?.trim() || getClientId(request);
  
  // Priority 1: Upstash Redis (fastest)
  const hasUpstash = process.env.UPSTASH_REDIS_REST_URL &&
                     process.env.UPSTASH_REDIS_REST_TOKEN;

  if (hasUpstash) {
    try {
      return await upstashRateLimit(identifier, config);
    } catch (error) {
      console.warn("[RateLimit] Upstash error, trying Supabase:", error);
    }
  }

  // Priority 2: Supabase PostgreSQL
  const hasSupabase = process.env.NEXT_PUBLIC_SUPABASE_URL &&
                      process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (hasSupabase) {
    try {
      return await supabaseRateLimit(identifier, config);
    } catch (error) {
      console.warn(
        "[RateLimit] Supabase error" +
          (config.failClosed ? " (failClosed → denying)" : ", falling back to in-memory:"),
        error,
      );
    }
  }

  // Fail-closed (DEV-4472): for sensitive endpoints, deny when no distributed
  // limiter is available rather than silently switching to non-distributed
  // in-memory counting (which is per-instance and effectively unlimited
  // across a multi-instance deployment or an outage).
  if (config.failClosed) {
    const windowMs = parseWindow(config.window);
    return {
      success: false,
      limit: config.limit,
      remaining: 0,
      reset: Date.now() + windowMs,
    };
  }

  // Priority 3: In-memory fallback (development only)
  if (process.env.NODE_ENV === "production" && !hasUpstash && !hasSupabase) {
    console.warn("[RateLimit] WARNING: Using in-memory rate limiting in production. Configure Upstash or Supabase for distributed rate limiting.");
  }

  return inMemoryRateLimit(identifier, config);
}

/**
 * Create rate limit headers for response
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": result.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": result.reset.toString(),
  };
}
