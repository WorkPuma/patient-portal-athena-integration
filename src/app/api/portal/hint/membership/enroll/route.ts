import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import {
  enrollMember,
  createPatient as createHintPatient,
} from "@/lib/hint/client";
import { captureServerEvent } from "@/lib/posthog/server";

/**
 * POST /api/portal/hint/membership/enroll
 * Enroll a patient in a HINT membership plan.
 * Auto-creates a HINT patient from Clerk user data if none is linked.
 */
export async function POST(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  const body = await request.json();
  const { planId, startDate } = body as {
    planId: string;
    startDate?: string;
  };

  if (!planId) {
    return NextResponse.json(
      { error: "planId is required" },
      { status: 400 }
    );
  }

  let hintPatientId = user.hintPatientId;

  if (!hintPatientId) {
    try {
      const { userId } = await auth();
      const client = await clerkClient();
      const clerkUser = await client.users.getUser(userId!);
      const email =
        clerkUser.emailAddresses.find(
          (e) => e.id === clerkUser.primaryEmailAddressId
        )?.emailAddress || "";

      const dob =
        (clerkUser.publicMetadata as Record<string, unknown>)?.dob;
      const hintPatient = await createHintPatient({
        first_name: clerkUser.firstName || "Unknown",
        last_name: clerkUser.lastName || "Unknown",
        email,
        dob: typeof dob === "string" ? dob : "",
        phone: clerkUser.phoneNumbers?.[0]?.phoneNumber || undefined,
      });

      hintPatientId = hintPatient.id;

      const meta = (clerkUser.publicMetadata || {}) as Record<string, unknown>;
      await client.users.updateUser(userId!, {
        publicMetadata: { ...meta, hintPatientId },
      });
    } catch (createErr) {
      console.error("[Portal] Auto-create HINT patient failed:", createErr);
      return NextResponse.json(
        { error: "Could not create HINT patient for enrollment" },
        { status: 500 }
      );
    }
  }

  try {
    const membership = await enrollMember({
      patient_id: hintPatientId,
      plan_id: planId,
      start_date: startDate,
    });

    try {
      await captureServerEvent(user.userId, "membership_enrolled_server", {
        plan_id: planId,
        flow: "portal",
      });
    } catch {
      // analytics never blocks the response
    }

    return NextResponse.json({ membership });
  } catch (error) {
    console.error("[Portal] HINT enrollment error:", error);
    return NextResponse.json(
      { error: "Failed to enroll in membership" },
      { status: 500 }
    );
  }
}
