import { NextResponse } from "next/server";
import { getPortalFeatureFlags } from "@/lib/portal/feature-flags";

/**
 * Short-circuit response for the public registration-funnel membership APIs
 * when the membership feature flag is OFF.
 *
 * Returns `null` when the feature is enabled (caller proceeds normally),
 * or a 410 Gone NextResponse when disabled. 410 (vs 404) signals "this
 * resource is intentionally retired in this configuration" so monitoring
 * doesn't alert on it like it would for a missing route.
 *
 * Scope: only the prospective-patient enrollment routes under
 * /api/portal/register/membership/*. The authenticated /api/portal/hint/
 * membership/* routes used by existing members are NOT gated here — those
 * stay live so people who already enrolled can still pay/renew/cancel.
 */
export function membershipDisabledResponse(): NextResponse | null {
  if (getPortalFeatureFlags().membership) return null;
  return NextResponse.json(
    {
      disabled: true,
      error:
        "Membership enrollment is not available in this environment.",
    },
    { status: 410 }
  );
}
