/**
 * GET /api/portal/register/insurance/brands
 *
 * Returns the curated patient-facing carrier brand catalog used by the
 * registration eligibility step. Replaces the 400+ Athena package autocomplete
 * with ~11 high-volume brand cards covering 98.30% of historical eligibility
 * traffic. Server-side resolvers handle brand → Stedi payer ID → Athena
 * `insurancepackageid` so the patient never sees those.
 *
 * Public route (registration is no-account by design). 60 req/min/IP rate
 * limit — same envelope as /insurance/search.
 *
 * Phase 1: in-code catalog from `src/lib/stedi/brand-resolver.ts`. Phase 2:
 * read from Supabase `portal_payer_brand`.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { withPortalErrors } from "@/lib/portal/api";
import { listPortalPayerBrands } from "@/lib/stedi/brand-resolver";

interface BrandCard {
  brandId: string;
  displayName: string;
  subtitle: string | null;
  productHint: string;
  isGovernmentFunded: boolean;
  guidedHandoff: boolean;
  enrollmentPending: boolean;
}

export async function GET(request: NextRequest) {
  return withPortalErrors("register-insurance-brands", async () => {
    const rl = await rateLimit(request, {
      limit: 60,
      window: "1m",
      prefix: "portal-register-ins-brands",
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429 }
      );
    }

    const brands: BrandCard[] = listPortalPayerBrands().map((b) => ({
      brandId: b.brandId,
      displayName: b.displayName,
      subtitle: b.subtitle ?? null,
      productHint: b.productHint,
      isGovernmentFunded: b.isGovernmentFunded,
      guidedHandoff: !!b.guidedHandoff,
      enrollmentPending: !!b.enrollmentPending,
    }));

    return NextResponse.json({ brands });
  });
}
