import { NextRequest, NextResponse } from "next/server";
import {
  shouldEnforceQStashSignature,
  verifyQStashSignature,
} from "@/lib/upstash/verify";

/**
 * QStash worker for asynchronous transactional email.
 *
 * Authenticated via QStash signature (Upstash-Signature header). In
 * production this route MUST verify; otherwise the public URL becomes an
 * open relay through our Resend identity — anyone could POST
 * `{to, subject, html}` and we would deliver it from
 * `<RESEND_FROM_NAME> <RESEND_FROM_EMAIL>`.
 *
 * Always invoked via `queueSendEmail()` in src/lib/upstash/queue.ts.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const verification = await verifyQStashSignature(
    rawBody,
    request.headers.get("upstash-signature"),
    request.url
  );
  if (!verification.ok && shouldEnforceQStashSignature()) {
    console.warn(
      "[Queue:Email] Rejected unsigned request:",
      verification.reason
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { to?: unknown; subject?: unknown; html?: unknown };
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const to = typeof payload.to === "string" ? payload.to.trim() : "";
  const subject =
    typeof payload.subject === "string" ? payload.subject.trim() : "";
  const html = typeof payload.html === "string" ? payload.html : "";

  if (!to || !subject || !html) {
    return NextResponse.json(
      { error: "to, subject, and html are required" },
      { status: 400 }
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return NextResponse.json(
      { error: "Invalid recipient address" },
      { status: 400 }
    );
  }

  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      // Return a 5xx so QStash records this as a delivery failure and
      // retries. A 200 OK here would cause QStash to drop the job
      // permanently — silently losing every transactional email in any
      // env where the key happens to be missing.
      console.error("[Queue:Email] RESEND_API_KEY not configured");
      return NextResponse.json(
        { error: "RESEND_API_KEY not configured on this deployment" },
        { status: 503 },
      );
    }

    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);

    const fromEmail =
      process.env.RESEND_FROM_EMAIL || "noreply@example-patient-portal.com";
    const fromName = process.env.RESEND_FROM_NAME || "Herself Health";

    await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Queue:Email] Error:", err);
    return NextResponse.json({ error: "Email send failed" }, { status: 500 });
  }
}
