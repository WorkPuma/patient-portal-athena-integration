import { NextResponse } from "next/server";
import {
  requireVerifiedIdentity,
  isPortalUser,
} from "@/lib/auth/clerk-session";
import {
  getPatient as getHintPatient,
  HintApiError,
} from "@/lib/hint/client";

const HINT_CONFIGURED = !!process.env.HINT_API_KEY;

/**
 * GET /api/portal/hint/patient
 * Returns the full Hint patient record including embedded membership data.
 * The patient endpoint is the authoritative source for membership status
 * since the memberships list endpoint doesn't reliably filter by patient.
 *
 * Gracefully returns null when Hint is not configured or the patient has no Hint ID.
 */
export async function GET() {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!HINT_CONFIGURED || !user.hintPatientId) {
    return NextResponse.json({ patient: null, membership: null });
  }

  try {
    const patient = await getHintPatient(user.hintPatientId);

    const activeMembership = patient.memberships?.find(
      (m) =>
        m.status === "active" ||
        m.status === "trialing" ||
        m.enrollment_status === "active"
    );

    return NextResponse.json({
      patient: {
        id: patient.id,
        firstName: patient.first_name,
        lastName: patient.last_name,
        email: patient.email,
        membershipStatus: patient.membership_status,
        pastDueCents: patient.account?.past_due_in_cents ?? 0,
        practitioner: patient.practitioner
          ? { id: patient.practitioner.id, name: patient.practitioner.name }
          : null,
        location: patient.location
          ? {
              id: patient.location.id,
              name: patient.location.name,
              address: patient.location.address_line1,
              city: patient.location.address_city,
              state: patient.location.address_state,
              zip: patient.location.address_zip,
              phone: patient.location.phone_number,
            }
          : null,
      },
      membership: activeMembership
        ? {
            planName: activeMembership.plan.name,
            planId: activeMembership.plan.id,
            planType: activeMembership.plan.plan_type,
            status: activeMembership.status,
            enrollmentStatus: activeMembership.enrollment_status,
            memberType: activeMembership.member_type,
            startDate: activeMembership.start_date,
            endDate: activeMembership.end_date,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof HintApiError && error.statusCode === 404) {
      return NextResponse.json({ patient: null, membership: null });
    }
    console.error("[Portal] Hint patient error:", error);
    return NextResponse.json({ patient: null, membership: null });
  }
}
