import { NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { getMemberships } from "@/lib/hint/client";

/**
 * GET /api/portal/hint/membership
 * Get membership info for the authenticated patient.
 */
export async function GET() {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!user.hintPatientId) {
    return NextResponse.json({ memberships: [] });
  }

  try {
    const memberships = await getMemberships({
      patientId: user.hintPatientId,
    });

    return NextResponse.json({ memberships });
  } catch (error) {
    console.error("[Portal] HINT memberships error:", error);
    return NextResponse.json(
      { error: "Failed to fetch membership info" },
      { status: 500 }
    );
  }
}
