import { NextRequest, NextResponse } from "next/server";
import { rateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { escapeSoql, SalesforceClient } from "@/lib/salesforce/client";
import { isValidEmail } from "@/lib/api-error-utils";
import { getChicagoBusinessWindow } from "@/lib/business-hours";
import { recordAuditEvent } from "@/lib/audit/audit-log";

const LIVE_PHONE_NUMBER = "555-123-4567";

/**
 * Handoff modes drive Salesforce Lead `LeadSource` and `Description`
 * so member services can sort the queue. Default mode is the legacy
 * "talk to a person now" widget; Dot adds two new modes:
 *
 *   - `callback_request` — same as legacy default, but emitted by Dot
 *     when the patient asks to speak to a human mid-conversation.
 *     Treated as a regular Membership lead so existing CRM workflows
 *     don't have to be reconfigured.
 *
 *   - `post_booking_confirmation` — Dot just booked an Initial Visit
 *     and wants member services to confirm member-id, demographics,
 *     and any insurance nuance Dot intentionally skipped. Annotates
 *     the Lead with the Athena patient/appointment ids.
 */
type HandoffMode = "default" | "callback_request" | "post_booking_confirmation";

interface HandoffPayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  context?: string;
  mode?: HandoffMode;
  patientId?: string;
  appointmentId?: string | number;
  /**
   * Optional Salesforce Lead Id from the registration session. When supplied
   * we PATCH that exact Lead instead of upserting by email — avoids creating
   * duplicate Leads when the patient registers via the wizard *and* later
   * triggers a Dot post-book confirmation.
   */
  leadId?: string;
}

function normalize(value: string | undefined): string {
  return value?.trim() ?? "";
}

function parsePayload(body: unknown): HandoffPayload {
  if (!body || typeof body !== "object") return {};
  return body as HandoffPayload;
}

export async function POST(request: NextRequest) {
  const limitResult = await rateLimit(request, {
    limit: 5,
    window: "1m",
    prefix: "portal-register-handoff",
    failClosed: true,
  });

  if (!limitResult.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: rateLimitHeaders(limitResult) }
    );
  }

  try {
    const payload = parsePayload(await request.json());
    const firstName = normalize(payload.firstName);
    const lastName = normalize(payload.lastName);
    const email = normalize(payload.email).toLowerCase();
    const phone = normalize(payload.phone);
    const context = normalize(payload.context);
    const mode: HandoffMode = (payload.mode as HandoffMode) || "default";
    const patientId = normalize(payload.patientId);
    const appointmentId = payload.appointmentId
      ? String(payload.appointmentId).trim()
      : "";
    const sessionLeadId = normalize(payload.leadId);

    if (!firstName || !lastName || !email) {
      return NextResponse.json(
        { error: "Missing required fields: firstName, lastName, email" },
        { status: 400 }
      );
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }

    const salesforce = await SalesforceClient.fromEnvironment();
    if (!salesforce) {
      return NextResponse.json(
        { error: "Salesforce is not configured" },
        { status: 503 }
      );
    }

    // Security (DEV-4471): never trust a client-supplied leadId. This is a
    // public, rate-limited registration endpoint; honoring a body leadId would
    // let anyone PATCH an arbitrary Salesforce Lead by Id (IDOR). Resolve the
    // lead by the supplied email only and create it if absent. The body
    // `leadId` field is accepted for backward compatibility but ignored.
    void sessionLeadId;
    const existingLeads = await salesforce.query<{ Id: string }>(
      `SELECT Id FROM Lead WHERE Email = '${escapeSoql(email)}' LIMIT 1`
    );

    const handoffWindow = getChicagoBusinessWindow();

    // Tailor the patient-facing closing message + Salesforce description
    // to the handoff mode. post_booking_confirmation patients have
    // already booked an appointment; the rest are pre-booking.
    const handoffMessage =
      mode === "post_booking_confirmation"
        ? `Thanks ${firstName}. We've booked your visit — someone from our team will reach out to confirm any remaining details.`
        : handoffWindow.isOpenNow
          ? `Thanks ${firstName}. Please call us now at ${LIVE_PHONE_NUMBER}.`
          : `Thanks ${firstName}. Someone will reach out to you on ${handoffWindow.nextBusinessDateLabel}.`;

    const descriptionPrefix =
      mode === "post_booking_confirmation"
        ? "Dot booked an Initial Visit — please confirm member id, demographics, and any insurance details Dot skipped."
        : mode === "callback_request"
          ? "Dot callback request — patient asked to speak to a human."
          : "Portal register chat handoff request.";

    const descriptionParts: string[] = [descriptionPrefix];
    if (patientId) descriptionParts.push(`Athena patient: ${patientId}.`);
    if (appointmentId)
      descriptionParts.push(`Athena appointment: ${appointmentId}.`);
    if (context) descriptionParts.push(`Context: ${context}`);

    const leadData: Record<string, unknown> = {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      LeadSource: "Membership",
      Company: "Individual",
      Description: descriptionParts.join(" ").slice(0, 3000),
    };
    if (phone) {
      leadData.MobilePhone = phone;
    }
    if (patientId) {
      leadData.Patient_ID__c = patientId;
    }

    let leadId = "";
    let isNewLead = false;
    if (existingLeads.totalSize === 0) {
      const created = await salesforce.createRecord("Lead", leadData);
      leadId = created.id;
      isNewLead = true;
    } else {
      leadId = existingLeads.records[0].Id;
      await salesforce.updateRecord("Lead", leadId, leadData);
    }

    void recordAuditEvent({
      actorType: "system",
      action: "phi.update.salesforce_handoff",
      subjectType: "salesforce_lead",
      subjectId: leadId,
      request,
      detail: { mode, isNewLead, athenaPatientId: patientId || null },
    });

    return NextResponse.json({
      success: true,
      leadId,
      isNewLead,
      mode,
      contactWindow: {
        isOpenNow: handoffWindow.isOpenNow,
        phoneNumber: LIVE_PHONE_NUMBER,
        nextBusinessDateLabel: handoffWindow.nextBusinessDateLabel,
        message: handoffMessage,
      },
    });
  } catch (error) {
    console.error("[portal/register/handoff] failed", error);
    return NextResponse.json(
      { error: "Unable to submit your request right now. Please try again." },
      { status: 500 }
    );
  }
}

