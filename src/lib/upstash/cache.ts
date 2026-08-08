import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

export interface CacheOptions {
  /** TTL in seconds */
  ttl?: number;
  /** Cache key prefix */
  prefix?: string;
}

const DEFAULT_TTL = 300; // 5 minutes
const DEFAULT_PREFIX = "portal";

function buildKey(prefix: string, key: string): string {
  return `${prefix}:${key}`;
}

export async function cacheGet<T>(key: string, opts?: CacheOptions): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const fullKey = buildKey(opts?.prefix ?? DEFAULT_PREFIX, key);
    const value = await client.get<T>(fullKey);
    return value;
  } catch (err) {
    console.warn("[Cache] GET error:", err);
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  opts?: CacheOptions
): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    const fullKey = buildKey(opts?.prefix ?? DEFAULT_PREFIX, key);
    const ttl = opts?.ttl ?? DEFAULT_TTL;
    await client.set(fullKey, value, { ex: ttl });
  } catch (err) {
    console.warn("[Cache] SET error:", err);
  }
}

export async function cacheDel(key: string, opts?: CacheOptions): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    const fullKey = buildKey(opts?.prefix ?? DEFAULT_PREFIX, key);
    await client.del(fullKey);
  } catch (err) {
    console.warn("[Cache] DEL error:", err);
  }
}

/**
 * Cache-through helper: returns cached value or fetches and stores it.
 */
export async function cacheThrough<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: CacheOptions
): Promise<T> {
  const cached = await cacheGet<T>(key, opts);
  if (cached !== null) return cached;

  const value = await fetcher();
  await cacheSet(key, value, opts);
  return value;
}

/**
 * Invalidate all cache keys matching a pattern prefix.
 */
export async function cacheInvalidatePrefix(pattern: string): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    const keys = await client.keys(`${pattern}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } catch (err) {
    console.warn("[Cache] Invalidate error:", err);
  }
}

export { getRedis };
