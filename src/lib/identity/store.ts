import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";
import type { ResolvedPatientIdentity } from "./resolver";

export interface PortalIdentityLinkRow {
  clerk_user_id: string;
  email_normalized: string | null;
  phone_normalized: string | null;
  empi_golden_id: string | null;
  sf_contact_id: string | null;
  athena_patient_id: string | null;
  hint_patient_id: string | null;
  match_score: number | null;
  resolver: string | null;
  resolved_at: string;
  updated_at: string;
}

let supabase: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (supabase) return supabase;
  // `readSupabaseEnv` defends against the `\r\n`-polluted env shape we
  // saw on 2026-05-12; without it identity link lookups would silently
  // return null and EVERY auto-link path would no-op.
  const env = readSupabaseEnv({ role: "service-role" });
  if (!env) return null;
  supabase = createClient(env.url, env.key, { db: { schema: "public" } });
  return supabase;
}

export async function getLinkByClerkUserId(
  clerkUserId: string
): Promise<PortalIdentityLinkRow | null> {
  const client = getClient();
  if (!client) return null;
  const { data } = await client
    .from("portal_identity_links")
    .select("*")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();
  return (data as PortalIdentityLinkRow | null) || null;
}

export async function findLinkByContact(
  emailNormalized: string,
  phoneNormalized: string
): Promise<PortalIdentityLinkRow | null> {
  const client = getClient();
  if (!client) return null;

  let query = client
    .from("portal_identity_links")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1);

  if (emailNormalized && phoneNormalized) {
    query = query.or(
      `email_normalized.eq.${emailNormalized},phone_normalized.eq.${phoneNormalized}`
    );
  } else if (emailNormalized) {
    query = query.eq("email_normalized", emailNormalized);
  } else if (phoneNormalized) {
    query = query.eq("phone_normalized", phoneNormalized);
  } else {
    return null;
  }

  const { data } = await query.maybeSingle();
  return (data as PortalIdentityLinkRow | null) || null;
}

/**
 * Count distinct golden records linked to the same email or phone.
 * Returns > 1 when family members share a contact and need DOB disambiguation.
 */
export async function countLinksByContact(
  emailNormalized: string,
  phoneNormalized: string
): Promise<number> {
  const client = getClient();
  if (!client) return 0;

  let query = client
    .from("portal_identity_links")
    .select("empi_golden_id", { count: "exact", head: true });

  if (emailNormalized && phoneNormalized) {
    query = query.or(
      `email_normalized.eq.${emailNormalized},phone_normalized.eq.${phoneNormalized}`
    );
  } else if (emailNormalized) {
    query = query.eq("email_normalized", emailNormalized);
  } else if (phoneNormalized) {
    query = query.eq("phone_normalized", phoneNormalized);
  } else {
    return 0;
  }

  const { count } = await query;
  return count ?? 0;
}

export async function upsertIdentityLink(params: {
  clerkUserId: string;
  emailNormalized: string;
  phoneNormalized: string;
  resolved?: ResolvedPatientIdentity;
}): Promise<void> {
  const client = getClient();
  if (!client) return;

  const payload = {
    clerk_user_id: params.clerkUserId,
    email_normalized: params.emailNormalized || null,
    phone_normalized: params.phoneNormalized || null,
    empi_golden_id: params.resolved?.empiGoldenId || null,
    sf_contact_id: params.resolved?.sfContactId || null,
    athena_patient_id: params.resolved?.athenaPatientId || null,
    hint_patient_id: params.resolved?.hintPatientId || null,
    match_score:
      typeof params.resolved?.matchScore === "number"
        ? params.resolved.matchScore
        : null,
    resolver: params.resolved?.resolver || null,
  };

  await client
    .from("portal_identity_links")
    .upsert(payload, { onConflict: "clerk_user_id" });
}

/**
 * Remove the Supabase identity link for a given Clerk user so the
 * auto-link flow runs fresh on next sign-in.
 */
export async function deleteLinkByClerkUserId(
  clerkUserId: string
): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client
    .from("portal_identity_links")
    .delete()
    .eq("clerk_user_id", clerkUserId);
}
