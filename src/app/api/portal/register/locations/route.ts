/**
 * GET /api/portal/register/locations
 *
 * Public list of patient-facing primary care clinic locations available to
 * a registrant choosing where to schedule their Initial Visit.
 * regToken-authenticated to keep the endpoint scoped to in-flight
 * registrations (and to keep our department metadata out of the open web).
 *
 * The list is curated server-side (see lib/portal/locations.ts) — the BH
 * and Vaccine Clinic departments are intentionally excluded.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import { rateLimit } from "@/lib/rate-limit";
import { withPortalErrors } from "@/lib/portal/api";
import { listActiveLocations } from "@/lib/portal/locations";

export async function GET(request: NextRequest) {
  return withPortalErrors("register-locations", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const rl = await rateLimit(request, {
      limit: 30,
      window: "1m",
      prefix: "portal-register-locations",
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429 }
      );
    }

    const locations = await listActiveLocations();
    return NextResponse.json({ locations });
  });
}
