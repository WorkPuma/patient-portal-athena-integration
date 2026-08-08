import { clerkClient, type User } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";
import {
  countLinksByContact,
  findLinkByContact,
  getLinkByClerkUserId,
  upsertIdentityLink,
} from "./store";
import {
  getNormalizedContactForUser,
  resolveAllCandidatesForUser,
  resolveByDobForUser,
  type ResolvedPatientIdentity,
} from "./resolver";
import { getPatient as getAthenaPatient } from "@/lib/athena/client";

export interface IdentityLinkResult {
  athenaPatientId?: string;
  sfContactId?: string;
  hintPatientId?: string;
  empiGoldenId?: string;
  resolver?: string;
  disambiguationRequired?: boolean;
  candidateCount?: number;
}

type PortalMetadata = Record<string, unknown> & {
  athenaPatientId?: string;
  sfContactId?: string;
  hintPatientId?: string;
  empiGoldenId?: string;
  disambiguationPending?: boolean;
};

function getMetaStrings(meta: PortalMetadata) {
  return {
    athenaPatientId: String(meta.athenaPatientId || "").trim(),
    sfContactId: String(meta.sfContactId || "").trim(),
    hintPatientId: String(meta.hintPatientId || "").trim(),
    empiGoldenId: String(meta.empiGoldenId || "").trim(),
  };
}

/**
 * Merge a resolved identity into Clerk publicMetadata WITHOUT silently
 * switching a patient's chart.
 *
 * CANONICAL IDENTITY AUTHORITY (DEV-4473): each ID is only written from
 * `resolved` when the existing value is empty OR already equal. If the
 * existing value is a *different* non-empty ID, we refuse to overwrite —
 * overwriting would re-link the Clerk user to a different patient's
 * chart. The conflict is logged via Sentry so an operator can reconcile.
 */
async function patchClerkMetadata(
  userId: string,
  existing: PortalMetadata,
  resolved: ResolvedPatientIdentity
) {
  const client = await clerkClient();
  const ids: Array<keyof Pick<PortalMetadata, "athenaPatientId" | "sfContactId" | "hintPatientId" | "empiGoldenId">> = [
    "athenaPatientId",
    "sfContactId",
    "hintPatientId",
    "empiGoldenId",
  ];
  const merged: PortalMetadata = { ...existing };
  for (const key of ids) {
    const incoming = String((resolved as unknown as Record<string, unknown>)[key] || "").trim();
    const current = String(existing[key] || "").trim();
    if (!incoming) continue;
    if (current && current !== incoming) {
      // Refuse to silently switch an established identity.
      captureServerMessage(
        `[auto-link] refusing to overwrite Clerk metadata ${key}; existing differs from resolved`,
        {
          level: "error",
          tags: { portal_op: "patch_clerk_metadata", field: key },
          extra: { userId, field: key, currentLength: current.length, incomingLength: incoming.length },
        },
      );
      continue;
    }
    (merged as Record<string, unknown>)[key] = incoming;
  }
  merged.disambiguationPending = false;
  await client.users.updateUser(userId, { publicMetadata: merged });
}

async function markDisambiguationPending(userId: string) {
  const client = await clerkClient();
  await client.users.updateUser(userId, {
    publicMetadata: { disambiguationPending: true },
  });
}

export async function ensurePortalIdentityLinked(
  user: User
): Promise<IdentityLinkResult | null> {
  if (process.env.PORTAL_AUTO_LINK_ENABLED === "false") return null;

  const meta = (user.publicMetadata || {}) as PortalMetadata;
  const existing = getMetaStrings(meta);
  const contact = getNormalizedContactForUser(user);

  // If disambiguation was flagged and not yet resolved, keep blocking.
  if (meta.disambiguationPending === true) {
    const candidates = await resolveAllCandidatesForUser(user);
    return {
      disambiguationRequired: true,
      candidateCount: candidates.length || 2,
    };
  }

  // If Clerk metadata already has patient IDs, the link is established.
  if (
    existing.athenaPatientId ||
    existing.sfContactId ||
    existing.hintPatientId ||
    existing.empiGoldenId
  ) {
    // CANONICAL IDENTITY AUTHORITY (DEV-4473): Clerk metadata is treated
    // as authoritative ONLY while it stays consistent with the EMPI
    // resolution for this user's verified contacts. A poisoned or stale
    // metadata value (e.g. from a prior contact-map auto-link on a
    // recycled number) would otherwise grant the wrong chart on every
    // subsequent sign-in. When EMPI returns a single, strong candidate
    // whose athenaPatientId DISAGREES with the stored value, hold the
    // user for DOB disambiguation instead of trusting either side
    // blindly. Disabled when PORTAL_CANONICAL_AUTHORITY_CHECK === "false".
    if (process.env.PORTAL_CANONICAL_AUTHORITY_CHECK !== "false") {
      try {
        const empiCandidates = await resolveAllCandidatesForUser(user);
        if (empiCandidates.length === 1) {
          const only = empiCandidates[0];
          const empiAthena = String(only.athenaPatientId || "").trim();
          if (
            empiAthena &&
            existing.athenaPatientId &&
            empiAthena !== existing.athenaPatientId
          ) {
            await markDisambiguationPending(user.id);
            return {
              disambiguationRequired: true,
              candidateCount: empiCandidates.length,
            };
          }
        }
      } catch (error) {
        // Never let the consistency check itself fail the link — log and
        // fall through to trust the established metadata.
        console.error(
          "[Portal] canonical authority consistency check error:",
          error,
        );
      }
    }

    await upsertIdentityLink({
      clerkUserId: user.id,
      emailNormalized: contact.email,
      phoneNormalized: contact.phone,
      resolved: {
        resolver: "upstash_vector",
        athenaPatientId: existing.athenaPatientId,
        sfContactId: existing.sfContactId,
        hintPatientId: existing.hintPatientId,
        empiGoldenId: existing.empiGoldenId,
      },
    });
    return existing;
  }

  const byClerkId = await getLinkByClerkUserId(user.id);
  if (byClerkId && byClerkId.athena_patient_id) {
    return {
      athenaPatientId: byClerkId.athena_patient_id || "",
      sfContactId: byClerkId.sf_contact_id || "",
      hintPatientId: byClerkId.hint_patient_id || "",
      empiGoldenId: byClerkId.empi_golden_id || "",
      resolver: byClerkId.resolver || "",
    };
  }

  // EMPI vector search — always check for multiple golden records FIRST
  // before any contact-based fallback, to prevent linking the wrong identity.
  const candidates = await resolveAllCandidatesForUser(user);

  if (candidates.length > 1) {
    await markDisambiguationPending(user.id);
    return {
      disambiguationRequired: true,
      candidateCount: candidates.length,
    };
  }

  if (candidates.length === 1) {
    const resolved = candidates[0];
    await patchClerkMetadata(user.id, meta, resolved);
    await upsertIdentityLink({
      clerkUserId: user.id,
      emailNormalized: contact.email,
      phoneNormalized: contact.phone,
      resolved,
    });
    return {
      athenaPatientId: resolved.athenaPatientId || "",
      sfContactId: resolved.sfContactId || "",
      hintPatientId: resolved.hintPatientId || "",
      empiGoldenId: resolved.empiGoldenId || "",
      resolver: resolved.resolver,
    };
  }

  // No EMPI match — check Supabase contact fallback for prior links.
  const contactLinkCount = await countLinksByContact(
    contact.email,
    contact.phone
  );
  if (contactLinkCount > 1) {
    await markDisambiguationPending(user.id);
    return { disambiguationRequired: true, candidateCount: contactLinkCount };
  }

  const byContact = await findLinkByContact(contact.email, contact.phone);
  if (byContact && byContact.athena_patient_id) {
    // SECURITY: do NOT auto-link from a single contact-map candidate.
    //
    // The contact-map keys on email/phone, both of which can be
    // recycled (carrier reassigns the number, mailbox provider
    // releases a lapsed account). Clerk verifies that the new signup
    // CAN receive OTP at that email/phone — it does not prove the
    // signup is the same human as the prior patient. Without a DOB
    // second factor, anyone who claims a recycled contact gets the
    // prior patient's chart.
    //
    // Mark the user as disambiguation-pending so the UI prompts for
    // DOB. `resolveDisambiguationByDob` will validate against the
    // contact-map candidate (or the EMPI candidates if any).
    Sentry.addBreadcrumb({
      category: "portal.auto-link",
      level: "info",
      message:
        "[auto-link] holding contact-map single-candidate for DOB verification",
      data: {
        userId: user.id,
        athenaPatientId: byContact.athena_patient_id,
      },
    });
    await markDisambiguationPending(user.id);
    return { disambiguationRequired: true, candidateCount: 1 };
  }

  // No match at all — record the empty link.
  await upsertIdentityLink({
    clerkUserId: user.id,
    emailNormalized: contact.email,
    phoneNormalized: contact.phone,
  });
  return null;
}

/**
 * Resolve a shared-contact disambiguation by validating the user's DOB.
 *
 * Two paths are tried in order:
 *   1. EMPI vector candidates (the original disambiguation path used
 *      when multiple golden records share an email/phone).
 *   2. Supabase contact-map candidate (the new path required after the
 *      2026-05 review: the contact-map single-candidate auto-link was
 *      replaced with a DOB-gated flow because email/phone alone can be
 *      recycled). Resolves by fetching the candidate patient from
 *      Athena and comparing the date-of-birth field.
 *
 * Links, persists, and clears the pending flag on the first match.
 * Returns `null` if neither path produces a DOB-verified candidate.
 */
export async function resolveDisambiguationByDob(
  user: User,
  dob: string,
): Promise<IdentityLinkResult | null> {
  const meta = (user.publicMetadata || {}) as PortalMetadata;
  const contact = getNormalizedContactForUser(user);

  // 1) EMPI vector path
  const empiMatched = await resolveByDobForUser(user, dob);
  if (empiMatched) {
    await patchClerkMetadata(user.id, meta, empiMatched);
    await upsertIdentityLink({
      clerkUserId: user.id,
      emailNormalized: contact.email,
      phoneNormalized: contact.phone,
      resolved: empiMatched,
    });
    return {
      athenaPatientId: empiMatched.athenaPatientId || "",
      sfContactId: empiMatched.sfContactId || "",
      hintPatientId: empiMatched.hintPatientId || "",
      empiGoldenId: empiMatched.empiGoldenId || "",
      resolver: "dob_disambiguation",
    };
  }

  // 2) Supabase contact-map path — only available when there's exactly
  //    one prior link by contact (the case held up by the new DOB gate).
  const byContact = await findLinkByContact(contact.email, contact.phone);
  if (!byContact?.athena_patient_id) return null;

  let athenaDob = "";
  try {
    const patient = await getAthenaPatient(byContact.athena_patient_id);
    // Athena returns dob as MM/DD/YYYY; normalize to YYYY-MM-DD for comparison.
    const rawDob = String(
      (patient as Record<string, unknown>).dob ?? "",
    ).trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawDob)) {
      const [m, d, y] = rawDob.split("/");
      athenaDob = `${y}-${m}-${d}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDob)) {
      athenaDob = rawDob;
    }
  } catch (e) {
    captureServerException(e, {
      tags: { portal_op: "dob_disambiguation_contact_map" },
      extra: { userId: user.id, athenaPatientId: byContact.athena_patient_id },
    });
    return null;
  }

  if (!athenaDob || athenaDob !== dob) {
    Sentry.addBreadcrumb({
      category: "portal.auto-link",
      level: "info",
      message: "[auto-link] contact-map DOB mismatch — refusing link",
      data: { userId: user.id },
    });
    return null;
  }

  const resolved: ResolvedPatientIdentity = {
    resolver: "supabase_contact_map_dob_verified",
    empiGoldenId: byContact.empi_golden_id || undefined,
    sfContactId: byContact.sf_contact_id || undefined,
    athenaPatientId: byContact.athena_patient_id || undefined,
    hintPatientId: byContact.hint_patient_id || undefined,
    dob,
    matchScore:
      typeof byContact.match_score === "number"
        ? byContact.match_score
        : undefined,
  };
  await patchClerkMetadata(user.id, meta, resolved);
  await upsertIdentityLink({
    clerkUserId: user.id,
    emailNormalized: contact.email,
    phoneNormalized: contact.phone,
    resolved,
  });
  return {
    athenaPatientId: resolved.athenaPatientId || "",
    sfContactId: resolved.sfContactId || "",
    hintPatientId: resolved.hintPatientId || "",
    empiGoldenId: resolved.empiGoldenId || "",
    resolver: resolved.resolver,
  };
}
