import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { createPhoneCall } from "@/lib/retell/client";

export async function POST(request: NextRequest) {
  // Security (DEV-4471): identity is derived from the verified Clerk session,
  // never from the body. Body-supplied athenaPatientId/sfContactId/patientName
  // are ignored to prevent cross-patient metadata injection.
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  try {
    const body = await request.json().catch(() => ({}));
    const { phone } = body as { phone?: string };

    if (!phone) {
      return NextResponse.json({ error: "Phone number is required" }, { status: 400 });
    }

    const agentId = process.env.RETELL_SMS_AGENT_ID;
    const fromNumber = process.env.RETELL_PHONE_NUMBER;

    if (!agentId || !fromNumber) {
      return NextResponse.json(
        { error: "Retell SMS agent not configured" },
        { status: 503 }
      );
    }

    const call = await createPhoneCall({
      agentId,
      toNumber: phone,
      fromNumber,
      metadata: {
        patient_name: user.displayName || "",
        athena_patient_id: user.athenaPatientId || "",
        sf_contact_id: user.sfContactId || "",
        phone,
      },
    });

    return NextResponse.json({
      callId: call.call_id,
      status: call.call_status,
    });
  } catch (err) {
    console.error("[Retell SMS] Error:", err);
    return NextResponse.json(
      { error: "Failed to initiate SMS scheduling call" },
      { status: 500 }
    );
  }
}
