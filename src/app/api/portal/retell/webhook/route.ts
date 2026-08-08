import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { captureServerMessage } from "@/lib/capture-exception";
import {
  shouldEnforceRetellSignature,
  verifyRetellSignature,
} from "@/lib/retell/verify";
import { readSupabaseEnv } from "@/lib/env";
import type { RetellWebhookEvent } from "@/lib/retell/types";
import { captureServerEvent } from "@/lib/posthog/server";
import { hashToOpaqueDistinctId } from "@/lib/posthog/sanitize";

function getSupabase() {
  // `readSupabaseEnv` defends against the `\r\n`-polluted env shape.
  const env = readSupabaseEnv({ role: "service-role" });
  if (!env) return null;
  return createClient(env.url, env.key, { auth: { persistSession: false } });
}

/**
 * Retell call lifecycle webhook (call_started / call_ended /
 * call_analyzed). Signed with HMAC-SHA256 over the raw body using the
 * Retell API key — same scheme our /api/portal/retell/tools and
 * /api/portal/retell/registration-tools routes verify. Without
 * verification, anyone could POST forged events that mark conversations
 * "completed" or write attacker-controlled transcript/summary content
 * into `portal_conversations`.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const verification = verifyRetellSignature(rawBody, request.headers);
  if (!verification.ok && shouldEnforceRetellSignature()) {
    captureServerMessage("Retell webhook: invalid signature", {
      level: "warning",
      extra: { reason: verification.reason },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    let event: RetellWebhookEvent;
    try {
      event = JSON.parse(rawBody) as RetellWebhookEvent;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }
    const { call } = event;

    const db = getSupabase();
    if (!db) {
      console.warn("[Retell Webhook] Supabase not configured");
      return NextResponse.json({ ok: true });
    }

    switch (event.event) {
      case "call_started": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db.from("portal_conversations") as any).upsert(
          {
            retell_call_id: call.call_id,
            sf_contact_id: call.metadata?.sf_contact_id || null,
            athena_patient_id: call.metadata?.athena_patient_id || null,
            phone: call.from_number || call.metadata?.phone || null,
            channel: call.call_type === "web_call" ? "chat" : "sms",
            status: "active",
          },
          { onConflict: "retell_call_id" }
        );
        break;
      }

      case "call_ended": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db.from("portal_conversations") as any)
          .update({ status: "completed" })
          .eq("retell_call_id", call.call_id);
        break;
      }

      case "call_analyzed": {
        const analysis = call.call_analysis;
        const appointmentBooked =
          analysis?.custom_analysis_data?.appointment_booked === true;
        const appointmentId =
          (analysis?.custom_analysis_data?.appointment_id as string) || null;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db.from("portal_conversations") as any)
          .update({
            summary: analysis?.call_summary || null,
            appointment_booked: appointmentBooked,
            appointment_id: appointmentId,
            metadata: {
              sentiment: analysis?.user_sentiment,
              successful: analysis?.call_successful,
              transcript: call.transcript,
            },
          })
          .eq("retell_call_id", call.call_id);

        // Conversation-level LLM trace: latency, outcome, sentiment.
        // distinctId is the hashed Athena patient id when known (links to
        // the registration person); falls back to hashed call id.
        try {
          const rawId = call.metadata?.athena_patient_id || call.call_id;
          const distinctId = await hashToOpaqueDistinctId(rawId);
          const latencySeconds =
            call.end_timestamp && call.start_timestamp
              ? (call.end_timestamp - call.start_timestamp) / 1000
              : undefined;
          await captureServerEvent(distinctId, "$ai_trace", {
            $ai_trace_id: call.call_id,
            $ai_span_name: "retell_conversation",
            $ai_latency: latencySeconds ?? null,
            $ai_model: "gpt-4.1",
            $ai_provider: "openai",
            call_type: call.call_type,
            call_successful: analysis?.call_successful ?? null,
            user_sentiment: analysis?.user_sentiment ?? null,
            appointment_booked: appointmentBooked,
          });
        } catch {
          // analytics never blocks the response
        }
        break;
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Retell Webhook] Error:", err);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
