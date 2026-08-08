/**
 * HIPAA audit logging (DEV-4475).
 *
 * Records PHI access and consequential patient-portal mutations to the
 * append-only hhv2.audit_events table. Best-effort: errors are reported to
 * Sentry but NEVER propagated — audit must not fail a request or become a
 * new outage surface. Callers should fire-and-forget (await is optional).
 *
 * Guidance:
 *   - Store OPAQUE identifiers (athenaPatientId, clerkUserId, appointmentId)
 *     NOT raw PHI values (no names, DOBs, phone numbers, diagnoses).
 *   - Use action verbs `phi.read.*` for reads, `phi.update.*` / `phi.create.*`
 *     for mutations, and `identity.*` for identity operations.
 *   - Record `outcome: "denied"` for authorization denials too — the audit
 *     trail must show what was attempted and blocked, not just successes.
 */

import type { NextRequest } from "next/server";
import { captureServerException } from "@/lib/capture-exception";

export type ActorType = "patient" | "admin" | "system" | "service";
export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEventInput {
  actorType: ActorType;
  actorId?: string;
  action: string;
  subjectType?: string;
  subjectId?: string;
  outcome?: AuditOutcome;
  request?: NextRequest | Request;
  detail?: Record<string, unknown>;
}

function clientIp(request?: NextRequest | Request): string | undefined {
  if (!request) return undefined;
  const headers = request.headers as Headers;
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip") || undefined;
}

let requestIdCounter = 0;
function ephemeralRequestId(): string {
  // Lightweight per-process counter; real distributed request ids can be
  // passed via detail.requestId when available.
  requestIdCounter += 1;
  return `proc-${process.pid}-${requestIdCounter}`;
}

/**
 * Record an audit event. Always resolves (never throws). Returns true when
 * the row was written, false when it was skipped/failed.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<boolean> {
  try {
    const { insertAuditEvent } = await import("@/lib/audit/audit-store");
    await insertAuditEvent({
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      action: input.action,
      subject_type: input.subjectType ?? null,
      subject_id: input.subjectId ?? null,
      outcome: input.outcome ?? "success",
      ip: clientIp(input.request) ?? null,
      request_id: ephemeralRequestId(),
      detail: input.detail ?? {},
    });
    return true;
  } catch (err) {
    // Best-effort: report but do not propagate.
    captureServerException(err, {
      level: "warning",
      tags: { portal_op: "audit_log", action: input.action },
      extra: { action: input.action, outcome: input.outcome },
    });
    return false;
  }
}
