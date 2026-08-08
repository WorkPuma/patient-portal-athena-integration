/**
 * GET /api/portal/register/insurance/search?q=blue+cross
 *
 * Public typeahead for the no-account registration flow. Reads from the
 * staged `portal_insurance_packages` Supabase table (hydrated by
 * `npm run sync:portal-insurance` from Zeno's MDM endpoint), NOT directly
 * from Athena's /insurancepackages or the Databricks data warehouse.
 *
 * Why staged?
 *   - Athena's /insurancepackages is flaky in preview (502s) and we don't
 *     want anonymous traffic hitting the warehouse.
 *   - The MDM table carries `government_funded_type`, which the wizard uses
 *     to skip the Membership step for Medicare/Medicaid patients (who aren't
 *     eligible for the membership program anyway).
 *
 * - 60 req/min/IP rate limit
 * - 24h Redis cache per query (re-invalidated whenever the sync script runs)
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { cacheGet, cacheSet } from "@/lib/upstash/cache";
import { withPortalErrors } from "@/lib/portal/api";
import { captureServerException } from "@/lib/capture-exception";
import {
  searchPortalInsurancePackages,
  type PortalInsurancePackage,
} from "@/lib/portal/insurance-packages";

const CACHE_TTL = 86400; // 24h
const CACHE_VERSION = "v2"; // bump when result shape changes

export async function GET(request: NextRequest) {
  return withPortalErrors("register-insurance-search", async () => {
    const rl = await rateLimit(request, {
      limit: 60,
      window: "1m",
      prefix: "portal-register-ins-search",
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many search requests" },
        { status: 429 }
      );
    }

    const q = request.nextUrl.searchParams.get("q")?.trim();
    if (!q || q.length < 2) {
      return NextResponse.json({ packages: [] });
    }

    const cacheKey = `ins:search:${CACHE_VERSION}:${q.toLowerCase().slice(0, 30)}`;

    const cached = await cacheGet<PortalInsurancePackage[]>(cacheKey, {
      prefix: "portal",
    });
    if (cached) {
      return NextResponse.json({ packages: cached });
    }

    try {
      const packages = await searchPortalInsurancePackages(q, 25);
      await cacheSet(cacheKey, packages, {
        prefix: "portal",
        ttl: CACHE_TTL,
      });
      return NextResponse.json({ packages });
    } catch (err) {
      captureServerException(err, {
        tags: { portal_route: "register-insurance-search" },
      });
      return NextResponse.json(
        { error: "Failed to search insurance packages" },
        { status: 502 }
      );
    }
  });
}
