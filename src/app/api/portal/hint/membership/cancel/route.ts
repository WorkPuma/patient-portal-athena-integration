import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import {
  cancelMembership,
  getMemberships,
  isWithin30DayGuarantee,
} from "@/lib/hint/client";
import { captureServerEvent } from "@/lib/posthog/server";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/hint/membership/cancel
 * Cancel a membership. If within 30-day guarantee, immediate cancellation.
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
  const { membershipId, reason } = body as {
    membershipId?: string;
    reason?: string;
  };

  try {
    let targetMembershipId = membershipId;

    if (!targetMembershipId) {
      const memberships = await getMemberships({
        patientId: user.hintPatientId,
        status: "active",
      });
      if (memberships.length === 0) {
        return NextResponse.json(
          { error: "No active membership found" },
          { status: 404 }
        );
      }
      targetMembershipId = memberships[0].id;
    }

    const memberships = await getMemberships({
      patientId: user.hintPatientId,
    });
    const membership = memberships.find((m) => m.id === targetMembershipId);

    // Ownership (DEV-4470): a caller-supplied membershipId that is not among
    // the authenticated user's own memberships must NOT be cancelled. Return
    // 404 (no oracle for whether the membership exists for someone else).
    if (!membership) {
      return NextResponse.json(
        { error: "No active membership found" },
        { status: 404 }
      );
    }

    const withinGuarantee = isWithin30DayGuarantee(membership);

    const result = await cancelMembership(targetMembershipId, {
      cancellation_reason: reason || "Patient requested cancellation via portal",
      cancel_at_period_end: !withinGuarantee,
    });

    void recordAuditEvent({
      actorType: "patient",
      actorId: user.userId,
      action: "phi.update.membership_cancel",
      subjectType: "membership",
      subjectId: targetMembershipId,
      request,
      detail: { withinGuarantee, cancelAtPeriodEnd: !withinGuarantee },
    });

    try {
      await captureServerEvent(user.userId, "membership_cancelled_server", {
        within_guarantee: withinGuarantee,
        cancel_at_period_end: !withinGuarantee,
      });
    } catch {
      // analytics never blocks the response
    }

    return NextResponse.json({
      membership: result,
      withinGuarantee,
      message: withinGuarantee
        ? "Your membership has been cancelled immediately under the 30-day money-back guarantee."
        : "Your membership will be cancelled at the end of the current billing period.",
    });
  } catch (error) {
    console.error("[Portal] HINT cancel error:", error);
    return NextResponse.json(
      { error: "Failed to cancel membership" },
      { status: 500 }
    );
  }
}
