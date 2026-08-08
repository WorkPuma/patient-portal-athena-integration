/**
 * Passive Clerk user provisioning.
 *
 * Creates a dormant Clerk account at registration time so the patient has
 * an identity they can later claim via SMS OTP without us having to
 * proactively prompt them now. Specifically:
 *
 *   - Phone number is the primary identifier (we always have it from
 *     /api/portal/register/patient).
 *   - Email is attached when the patient provided one.
 *   - No password is set (`skipPasswordRequirement: true`).
 *   - Public metadata carries athenaPatientId / hintPatientId / source so
 *     the eventual claim flow can reconcile without a regToken.
 *
 * Important — silent by design:
 *   - Clerk does NOT auto-send SMS or email when `users.createUser` is
 *     called; verification SMS/emails only happen at the moment the user
 *     initiates `verification.sendCode` from a sign-in attempt. Creating
 *     the user here therefore costs no SMS units and surfaces nothing to
 *     the patient.
 *   - We also don't surface anything to the patient in the UI. The
 *     RegistrationConfirmation page deliberately omits any account-related
 *     copy when `authUi` is off (see feature-flags).
 *
 * Idempotency:
 *   - If a Clerk user already exists for this phone (or email), we patch
 *     its publicMetadata instead of throwing. This makes the call safe to
 *     re-run from idempotency replays of /register/patient.
 *
 * Failure mode:
 *   - All errors are swallowed and reported to Sentry as warnings. We do
 *     NOT propagate; passive Clerk provisioning is a best-effort future-
 *     proofing step and must never fail a real Athena registration.
 */

import { clerkClient } from "@clerk/nextjs/server";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";

export interface PassiveClerkInput {
  /** E.164, e.g. "+15551234567". Required — primary identifier. */
  phone: string;
  /** Optional email; attached as a secondary identifier when present. */
  email?: string;
  firstName?: string;
  lastName?: string;
  athenaPatientId: string;
  hintPatientId?: string;
  /** Athena department the patient registered under (for downstream reporting). */
  departmentId?: number;
}

export interface PassiveClerkResult {
  /** Set when we successfully created or patched. `null` on safety-skip. */
  clerkUserId?: string | null;
  status:
  | "created"
  | "patched_existing"
  | "skipped"
  | "ambiguous_phone_skipped"
  | "ambiguous_email_skipped"
  | "conflicting_identity_skipped"
  | "error";
  /** Why the call short-circuited (only set when status === "skipped"). */
  reason?: string;
  /** Sentry event id when status === "error". */
  sentryEventId?: string;
}

/** Normalize email for Clerk lookup. Returns undefined for empty/invalid. */
function normalizeEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.includes("@")) return undefined;
  return trimmed;
}

/** Loose E.164 check — anything starting with + and 8-15 digits. */
function isLikelyE164(phone: string): boolean {
  return /^\+\d{8,15}$/.test(phone.trim());
}

/** Coerce a metadata value to a trimmed string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Create (or patch) a dormant Clerk user for this patient.
 *
 * Always returns — never throws. Caller is expected to fire-and-forget
 * (or `await` and ignore the result for audit purposes).
 */
export async function createPassiveClerkUser(
  input: PassiveClerkInput
): Promise<PassiveClerkResult> {
  const phone = input.phone?.trim();
  if (!phone || !isLikelyE164(phone)) {
    return { status: "skipped", reason: "invalid_phone" };
  }
  const email = normalizeEmail(input.email);

  const metadataPatch = {
    athenaPatientId: input.athenaPatientId,
    hintPatientId: input.hintPatientId || undefined,
    departmentId: input.departmentId,
    source: "passive_registration" as const,
    passiveCreatedAt: new Date().toISOString(),
  };

  try {
    const clerk = await clerkClient();

    // 1) De-dup by phone first. Clerk normalizes E.164 internally.
    //
    // SAFETY: refuse to silently pick a user when MORE THAN ONE Clerk
    // user shares the phone number. This can happen with legacy /
    // migrated data, OR when a phone number got recycled by the
    // carrier and reassigned to a different human. Patching
    // `publicMetadata.athenaPatientId` on the wrong user would link
    // them to a stranger's chart on next sign-in. Escalate to Sentry
    // and decline to patch — `auto-link.ts` will handle the
    // disambiguation flow at first sign-in with the proper DOB gate.
    const byPhone = await clerk.users.getUserList({ phoneNumber: [phone] });
    if (byPhone.data && byPhone.data.length > 1) {
      captureServerMessage(
        "[passive-clerk] multiple Clerk users share this phone; refusing to patch",
        {
          level: "error",
          tags: { portal_op: "passive_clerk_create" },
          extra: {
            phone,
            email,
            athenaPatientId: input.athenaPatientId,
            candidateIds: byPhone.data.map((u) => u.id),
          },
        },
      );
      return {
        clerkUserId: null,
        status: "ambiguous_phone_skipped",
      };
    }
    const byEmail =
      email && !byPhone.data?.[0]
        ? await clerk.users.getUserList({ emailAddress: [email] })
        : null;
    if (byEmail?.data && byEmail.data.length > 1) {
      captureServerMessage(
        "[passive-clerk] multiple Clerk users share this email; refusing to patch",
        {
          level: "error",
          tags: { portal_op: "passive_clerk_create" },
          extra: {
            phone,
            email,
            athenaPatientId: input.athenaPatientId,
            candidateIds: byEmail.data.map((u) => u.id),
          },
        },
      );
      return {
        clerkUserId: null,
        status: "ambiguous_email_skipped",
      };
    }
    const existing = byPhone.data?.[0] || byEmail?.data?.[0];

    if (existing) {
      // CANONICAL IDENTITY AUTHORITY (DEV-4473):
      // A single Clerk match on phone/email is NOT proof it's the same
      // human. Carrier-recycled numbers and reused mailboxes mean an
      // existing Clerk user can be a different patient. If that user
      // already carries a DIFFERENT athenaPatientId, patching ours onto
      // them would silently re-link a stranger to this patient's chart
      // on their next sign-in. Only patch when the existing user is
      // truly dormant (no athenaPatientId) or already bound to THIS
      // patient. Otherwise skip + escalate.
      const existingAthenaId = asString(
        (existing.publicMetadata || {}).athenaPatientId,
      );
      if (
        existingAthenaId &&
        existingAthenaId !== input.athenaPatientId
      ) {
        captureServerMessage(
          "[passive-clerk] existing Clerk user bound to a different patient; refusing to overwrite identity",
          {
            level: "error",
            tags: { portal_op: "passive_clerk_create" },
            extra: {
              phone,
              email,
              athenaPatientId: input.athenaPatientId,
              existingAthenaId,
              existingClerkUserId: existing.id,
            },
          },
        );
        return {
          clerkUserId: null,
          status: "conflicting_identity_skipped",
          reason: "existing_user_bound_to_different_patient",
        };
      }
      const merged = {
        ...(existing.publicMetadata || {}),
        ...metadataPatch,
      };
      await clerk.users.updateUser(existing.id, { publicMetadata: merged });
      return { clerkUserId: existing.id, status: "patched_existing" };
    }

    // 2) Create the new dormant user. No password, no verification SMS.
    const created = await clerk.users.createUser({
      phoneNumber: [phone],
      ...(email ? { emailAddress: [email] } : {}),
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.lastName ? { lastName: input.lastName } : {}),
      skipPasswordRequirement: true,
      skipPasswordChecks: true,
      // legalAcceptedAt is required when the Clerk instance enforces a
      // legal-consent policy. We capture consent on the registration form
      // (terms + SMS); record now to satisfy that requirement.
      legalAcceptedAt: new Date(),
      publicMetadata: metadataPatch,
    });
    return { clerkUserId: created.id, status: "created" };
  } catch (err) {
    const sentryEventId = captureServerException(err, {
      level: "warning",
      tags: {
        portal_route: "register-patient",
        step: "passive_clerk_create",
        severity: "non_fatal",
      },
      extra: {
        phone: phone.replace(/\d(?=\d{4})/g, "*"),
        hasEmail: Boolean(email),
        athenaPatientId: input.athenaPatientId,
      },
    });
    return { status: "error", sentryEventId };
  }
}
