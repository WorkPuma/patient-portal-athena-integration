/**
 * Supabase accessor for the append-only hhv2.audit_events table (DEV-4475).
 * Service-role only; mirrors the capability-store client pattern.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";

type Client = SupabaseClient;
let client: Client | null = null;

function getClient(): Client | null {
  if (client) return client;
  const env = readSupabaseEnv({ role: "service-role" });
  if (!env) return null;
  client = createClient(env.url, env.key, { db: { schema: "hhv2" } }) as unknown as Client;
  return client;
}

export interface AuditEventRow {
  actor_type: string;
  actor_id: string | null;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  outcome: string;
  ip: string | null;
  request_id: string | null;
  detail: Record<string, unknown>;
}

export async function insertAuditEvent(row: AuditEventRow): Promise<void> {
  const sb = getClient();
  if (!sb) return; // audit is best-effort; never block on missing config
  const { error } = await sb.from("audit_events").insert({
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    outcome: row.outcome,
    ip: row.ip,
    request_id: row.request_id,
    detail: row.detail,
  });
  if (error) {
    throw new Error(`audit insert failed: ${error.message}`);
  }
}
