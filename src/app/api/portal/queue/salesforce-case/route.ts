import { NextRequest, NextResponse } from "next/server";
import { getSalesforceToken } from "@/lib/auth/salesforce";
import {
  shouldEnforceQStashSignature,
  verifyQStashSignature,
} from "@/lib/upstash/verify";

/**
 * QStash worker for asynchronous Salesforce Case creation.
 *
 * Authenticated via QStash signature. Without it the public URL would
 * accept anonymous POSTs with arbitrary `contactId`, allowing a caller
 * to forge Cases bound to any Contact in the org. The user-facing route
 * for Case creation lives at /api/portal/salesforce/cases and binds the
 * Case to the authenticated PortalUser's sfContactId — that is the only
 * path that should accept patient-driven input.
 *
 * Always invoked via `queueCreateSalesforceCase()` in
 * src/lib/upstash/queue.ts (server-to-server, ContactId already
 * resolved by the publisher).
 */

const SALESFORCE_ID = /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const verification = await verifyQStashSignature(
    rawBody,
    request.headers.get("upstash-signature"),
    request.url
  );
  if (!verification.ok && shouldEnforceQStashSignature()) {
    console.warn(
      "[Queue:SF Case] Rejected unsigned request:",
      verification.reason
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: {
    contactId?: unknown;
    subject?: unknown;
    description?: unknown;
    origin?: unknown;
  };
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contactId =
    typeof payload.contactId === "string" ? payload.contactId.trim() : "";
  const subject =
    typeof payload.subject === "string" ? payload.subject.trim() : "";
  const description =
    typeof payload.description === "string" ? payload.description : "";
  const origin =
    typeof payload.origin === "string" && payload.origin.trim()
      ? payload.origin.trim()
      : "Her";

  if (!contactId || !SALESFORCE_ID.test(contactId)) {
    return NextResponse.json(
      { error: "Invalid contactId" },
      { status: 400 }
    );
  }
  if (!subject || !description) {
    return NextResponse.json(
      { error: "subject and description are required" },
      { status: 400 }
    );
  }

  try {
    const auth = await getSalesforceToken();
    if (!auth) {
      console.error("[Queue:SF Case] Failed to get Salesforce access token");
      return NextResponse.json({ error: "Salesforce auth failed" }, { status: 500 });
    }

    const caseData = {
      ContactId: contactId,
      Subject: subject,
      Description: description,
      Origin: origin,
      Status: "New",
      Priority: "Medium",
    };

    const res = await fetch(
      `${auth.instanceUrl}/services/data/v62.0/sobjects/Case`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(caseData),
      }
    );

    if (!res.ok) {
      const error = await res.text();
      console.error("[Queue:SF Case] Create failed:", error);
      return NextResponse.json({ error: "Case creation failed" }, { status: 500 });
    }

    const result = await res.json();
    return NextResponse.json({ id: result.id, ok: true });
  } catch (err) {
    console.error("[Queue:SF Case] Error:", err);
    return NextResponse.json({ error: "Case creation failed" }, { status: 500 });
  }
}
