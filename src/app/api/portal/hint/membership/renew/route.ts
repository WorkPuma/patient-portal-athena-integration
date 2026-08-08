import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { renewMembership, getMemberships } from "@/lib/hint/client";
import { captureServerEvent } from "@/lib/posthog/server";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/hint/membership/renew
 * Renew a membership contract.
 */
export async function POST(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!user.hintPatientId) {
    return NextResponse.json(
      { error: "No HINT patient linked" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const { membershipId, planId } = body as {
    membershipId?: string;
    planId?: string;
  };

  try {
    let targetMembershipId = membershipId;
    if (!targetMembershipId) {
      const memberships = await getMemberships({
        patientId: user.hintPatientId,
      });
      const current = memberships.find(
        (m) => m.status === "active" || m.status === "past_due"
      );
      if (!current) {
        return NextResponse.json(
          { error: "No membership found to renew" },
          { status: 404 }
        );
      }
      targetMembershipId = current.id;
    } else {
      // Ownership (DEV-4470): a caller-supplied membershipId must be verified
      // against the authenticated user's own memberships before renewing.
      // No oracle for whether it belongs to someone else — return 404 on
      // mismatch.
      const memberships = await getMemberships({
        patientId: user.hintPatientId,
      });
      const owned = memberships.find((m) => m.id === targetMembershipId);
      if (!owned) {
        return NextResponse.json(
          { error: "No membership found to renew" },
          { status: 404 }
        );
      }
    }

    const membership = await renewMembership(targetMembershipId, {
      plan_id: planId,
    });

    void recordAuditEvent({
      actorType: "patient",
      actorId: user.userId,
      action: "phi.update.membership_renew",
      subjectType: "membership",
      subjectId: targetMembershipId,
      request,
      detail: { planId: planId ?? null },
    });

    try {
      await captureServerEvent(user.userId, "membership_renewed_server", {
        membership_id: targetMembershipId,
        plan_id: planId ?? null,
      });
    } catch {
      // analytics never blocks the response
    }

    return NextResponse.json({ membership });
  } catch (error) {
    console.error("[Portal] HINT renew error:", error);
    return NextResponse.json(
      { error: "Failed to renew membership" },
      { status: 500 }
    );
  }
}
