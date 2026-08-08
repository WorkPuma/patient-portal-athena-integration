import { NextRequest, NextResponse } from "next/server";
import {
  requireVerifiedIdentity,
  isPortalUser,
} from "@/lib/auth/clerk-session";
import { searchInsurancePackages } from "@/lib/athena/client";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const CACHE_TTL = 86400; // 24 hours

/**
 * GET /api/portal/athena/insurance/search?q=blue+cross&memberId=XYZ
 * Typeahead search for insurance packages with Redis caching.
 */
export async function GET(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;

  const q = request.nextUrl.searchParams.get("q")?.trim();
  const memberId = request.nextUrl.searchParams.get("memberId") || undefined;

  if (!q || q.length < 2) {
    return NextResponse.json({ packages: [] });
  }

  const cacheKey = `ins:search:${q.toLowerCase().slice(0, 30)}`;

  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      const packages = typeof cached === "string" ? JSON.parse(cached) : cached;
      return NextResponse.json({ packages });
    }
  } catch {
    // Cache miss or unavailable, continue to live query
  }

  try {
    const packages = await searchInsurancePackages(q, memberId);

    const simplified = packages.map((p) => ({
      insurancepackageid: p.insurancepackageid,
      insuranceplanname: p.insuranceplanname,
    }));

    try {
      await redis.set(cacheKey, JSON.stringify(simplified), { ex: CACHE_TTL });
    } catch {
      // Cache write failure is non-fatal
    }

    return NextResponse.json({ packages: simplified });
  } catch (error) {
    console.error("[Portal] Insurance search error:", error);
    return NextResponse.json(
      { error: "Failed to search insurance packages" },
      { status: 500 }
    );
  }
}
