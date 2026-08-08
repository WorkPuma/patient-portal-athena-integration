/**
 * Durable schedule-link records in Supabase.
 *
 * Opaque tokens map to patient claims here. Redis (schedule-link-store)
 * remains the single-use burn lock for concurrent bookings.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";

export type ScheduleLinkStatus = "active" | "used" | "revoked";

export interface ScheduleLinkRecord {
  token: string;
  athenaPatientId: string;
  salesforceAccountId?: string;
  departmentId?: number;
  phone?: string;
  firstName?: string;
  status: ScheduleLinkStatus;
  /** Unix seconds */
  expiresAt: number;
  /** Unix seconds */
  createdAt: number;
  usedAt?: number;
  createdBy: string;
}

export interface CreateScheduleLinkInput {
  athenaPatientId: string;
  salesforceAccountId?: string;
  departmentId?: number;
  phone?: string;
  firstName?: string;
  /** Unix seconds */
  expiresAt: number;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

interface ScheduleLinkRow {
  token: string;
  athena_patient_id: string;
  salesforce_account_id: string | null;
  department_id: number | null;
  phone: string | null;
  first_name: string | null;
  status: ScheduleLinkStatus;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  created_by: string;
}

let supabase: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (supabase) return supabase;
  const env = readSupabaseEnv({ role: "service-role" });
  if (!env) return null;
  supabase = createClient(env.url, env.key, { db: { schema: "public" } });
  return supabase;
}

function toRecord(row: ScheduleLinkRow): ScheduleLinkRecord {
  return {
    token: row.token,
    athenaPatientId: row.athena_patient_id,
    salesforceAccountId: row.salesforce_account_id ?? undefined,
    departmentId: row.department_id ?? undefined,
    phone: row.phone ?? undefined,
    firstName: row.first_name ?? undefined,
    status: row.status,
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    createdAt: Math.floor(new Date(row.created_at).getTime() / 1000),
    usedAt: row.used_at
      ? Math.floor(new Date(row.used_at).getTime() / 1000)
      : undefined,
    createdBy: row.created_by,
  };
}

/** Insert a new opaque schedule-link row. Returns null when Supabase is down. */
export async function insertScheduleLinkRecord(
  token: string,
  input: CreateScheduleLinkInput
): Promise<ScheduleLinkRecord | null> {
  const client = getClient();
  if (!client) return null;

  const row = {
    token,
    athena_patient_id: input.athenaPatientId,
    salesforce_account_id: input.salesforceAccountId ?? null,
    department_id: input.departmentId ?? null,
    phone: input.phone ?? null,
    first_name: input.firstName ?? null,
    status: "active" as const,
    expires_at: new Date(input.expiresAt * 1000).toISOString(),
    created_by: input.createdBy ?? "mint",
    metadata: input.metadata ?? {},
  };

  const { data, error } = await client
    .from("portal_schedule_links")
    .insert(row)
    .select(
      "token, athena_patient_id, salesforce_account_id, department_id, phone, first_name, status, expires_at, created_at, used_at, created_by"
    )
    .single();

  if (error || !data) {
    console.warn("[schedule-link] insertScheduleLinkRecord error:", error);
    return null;
  }
  return toRecord(data as ScheduleLinkRow);
}

/** Load a schedule-link by opaque token. Returns null if missing or DB down. */
export async function getScheduleLinkRecord(
  token: string
): Promise<ScheduleLinkRecord | null> {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from("portal_schedule_links")
    .select(
      "token, athena_patient_id, salesforce_account_id, department_id, phone, first_name, status, expires_at, created_at, used_at, created_by"
    )
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.warn("[schedule-link] getScheduleLinkRecord error:", error);
    return null;
  }
  if (!data) return null;
  return toRecord(data as ScheduleLinkRow);
}

/** Mark a link used after Redis consume wins. Best-effort. */
export async function markScheduleLinkUsed(token: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    const { error } = await client
      .from("portal_schedule_links")
      .update({ status: "used", used_at: new Date().toISOString() })
      .eq("token", token)
      .eq("status", "active");
    if (error) {
      console.warn("[schedule-link] markScheduleLinkUsed error:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[schedule-link] markScheduleLinkUsed error:", err);
    return false;
  }
}

/** Restore used → active after a recoverable booking failure. Best-effort. */
export async function markScheduleLinkActive(token: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    const { error } = await client
      .from("portal_schedule_links")
      .update({ status: "active", used_at: null })
      .eq("token", token);
    if (error) {
      console.warn("[schedule-link] markScheduleLinkActive error:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[schedule-link] markScheduleLinkActive error:", err);
    return false;
  }
}

/** Delete a row (used when Redis registration fails after insert). */
export async function deleteScheduleLinkRecord(token: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.from("portal_schedule_links").delete().eq("token", token);
  } catch (err) {
    console.warn("[schedule-link] deleteScheduleLinkRecord error:", err);
  }
}
