import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { resolveDisambiguationByDob } from "@/lib/identity/auto-link";
import { rateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import type { NextRequest } from "next/server";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/identity/verify-dob
 *
 * Resolves shared-contact disambiguation by matching the user-provided
 * DOB against EMPI golden record candidates. Only called when the
 * auto-link flow detects multiple golden records for the same phone/email.
 *
 * Abuse control (DEV-4472): a strict per-user attempt cap prevents DOB
 * brute-forcing. The limiter is fail-closed — if the distributed limiter
 * is unavailable, the endpoint denies rather than allowing unlimited
 * local in-memory guesses.
 */
const DOB_ATTEMPT_LIMIT = 5;
const DOB_ATTEMPT_WINDOW = "15m";

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Per-user DOB attempt lockout. Bucket on userId (not IP) so a rotating
  // IP cannot bypass the cap. failClosed so an Upstash/Supabase outage
  // does not silently switch to unlimited in-memory guessing.
  const rl = await rateLimit(request, {
    limit: DOB_ATTEMPT_LIMIT,
    window: DOB_ATTEMPT_WINDOW,
    prefix: "portal-verify-dob",
    identifierOverride: userId,
    failClosed: true,
  });
  if (!rl.success) {
    return NextResponse.json(
      {
        error: "Too many verification attempts. Please try again later or contact support.",
      },
      { status: 429, headers: rateLimitHeaders(rl) }
    );
  }

  let body: { dob?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const dob = body.dob?.trim();
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return NextResponse.json(
      { error: "Date of birth is required in YYYY-MM-DD format" },
      { status: 400 }
    );
  }

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const linked = await resolveDisambiguationByDob(user, dob);

  void recordAuditEvent({
    actorType: "patient",
    actorId: userId,
    action: "identity.verify_dob",
    subjectType: "identity",
    subjectId: userId,
    outcome: linked ? "success" : "denied",
    request,
    // Never log the raw DOB; only the match outcome.
    detail: linked ? { resolved: true } : { resolved: false },
  });

  if (!linked) {
    return NextResponse.json(
      {
        linked: false,
        message:
          "We could not match your date of birth to a record. " +
          "Please contact support if you need help.",
      },
      { status: 422 }
    );
  }

  return NextResponse.json({ linked: true, ...linked });
}
