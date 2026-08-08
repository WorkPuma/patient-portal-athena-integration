import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { getInvoice, payInvoice } from "@/lib/hint/client";
import { captureServerEvent } from "@/lib/posthog/server";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/hint/invoices/[id]/pay
 * Pay an outstanding invoice owned by the authenticated portal user.
 *
 * Security (DEV-4470):
 *   - Identity is derived solely from requireVerifiedIdentity(); the URL `id`
 *     is validated against the caller's own hintPatientId before any mutation.
 *   - The payment amount is derived from the invoice's server-side balance; a
 *     client-supplied `amount_cents` is ignored (prevents over/under-payment
 *     against another patient's invoice).
 *   - A mismatched or non-owned invoice returns 404 (no oracle for existence).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!user.hintPatientId) {
    return NextResponse.json(
      { error: "No HINT patient linked" },
      { status: 400 }
    );
  }

  const { id } = await params;

  let invoice;
  try {
    invoice = await getInvoice(id);
  } catch (error) {
    console.error("[Portal] HINT get invoice error:", error);
    return NextResponse.json(
      { error: "Failed to load invoice" },
      { status: 502 }
    );
  }

  // Exact ownership: the invoice must belong to the authenticated user's
  // Hint patient. No body patient_id is honored.
  if (!invoice || invoice.patient_id !== user.hintPatientId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Derive the payment amount server-side from the outstanding balance.
  const amount_cents = invoice.balance_cents;

  try {
    const paid = await payInvoice(id, { amount_cents });

    void recordAuditEvent({
      actorType: "patient",
      actorId: user.userId,
      action: "phi.update.invoice_pay",
      subjectType: "invoice",
      subjectId: id,
      request,
      detail: { amountCents: typeof amount_cents === "number" ? amount_cents : null },
    });

    try {
      await captureServerEvent(user.userId, "invoice_paid_server", {
        amount_cents,
      });
    } catch {
      // analytics never blocks the response
    }

    return NextResponse.json({ invoice: paid });
  } catch (error) {
    console.error("[Portal] HINT pay invoice error:", error);
    return NextResponse.json(
      { error: "Failed to pay invoice" },
      { status: 500 }
    );
  }
}
