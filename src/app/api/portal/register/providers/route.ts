/**
 * GET /api/portal/register/providers[?location=<slug>]
 *
 * Returns the curated provider directory used by the registration scheduler.
 * When `location` is supplied (Storyblok slug, e.g. "highland-park") we
 * filter to providers who practice at that clinic.
 *
 * Joins Athena `/providers` (source of truth for bookable identity) with
 * Storyblok `provider_profile` content (headshots, credentials, location
 * affinities). See lib/portal/providers.ts for the matching strategy.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import { rateLimit } from "@/lib/rate-limit";
import { withPortalErrors } from "@/lib/portal/api";
import {
  filterProvidersByLocation,
  listProviderDirectory,
} from "@/lib/portal/providers";
import { listActiveLocations } from "@/lib/portal/locations";

export async function GET(request: NextRequest) {
  return withPortalErrors("register-providers", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const rl = await rateLimit(request, {
      limit: 30,
      window: "1m",
      prefix: "portal-register-providers",
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429 }
      );
    }

    const locationSlug = request.nextUrl.searchParams.get("location");

    let providers = await listProviderDirectory();
    if (locationSlug) {
      // Validate against the curated location list so callers can't probe
      // arbitrary slug values.
      const known = await listActiveLocations();
      if (!known.some((l) => l.slug === locationSlug)) {
        return NextResponse.json(
          { error: "Unknown clinic location" },
          { status: 400 }
        );
      }
      providers = filterProvidersByLocation(providers, locationSlug);
    }

    return NextResponse.json({ providers });
  });
}
