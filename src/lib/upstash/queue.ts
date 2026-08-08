import { Client } from "@upstash/qstash";

let qstash: Client | null = null;

function getQStash(): Client | null {
  if (qstash) return qstash;
  const token = process.env.UPSTASH_QSTASH_TOKEN;
  if (!token) return null;
  qstash = new Client({ token });
  return qstash;
}

export interface QueueMessage {
  /** Target URL to receive the message */
  destination: string;
  /** JSON-serializable payload */
  body: Record<string, unknown>;
  /** Delay in seconds before delivery */
  delay?: number;
  /** Number of retry attempts */
  retries?: number;
  /** Deduplication ID to prevent duplicate processing */
  deduplicationId?: string;
}

/**
 * Publish a message to a QStash destination.
 * Falls back to synchronous fetch if QStash is not configured.
 */
export async function publishMessage(msg: QueueMessage): Promise<{ messageId?: string }> {
  const client = getQStash();

  if (!client) {
    console.warn("[Queue] QStash not configured, executing synchronously");
    try {
      await fetch(msg.destination, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.body),
      });
      return {};
    } catch (err) {
      console.error("[Queue] Sync fallback error:", err);
      return {};
    }
  }

  try {
    const result = await client.publishJSON({
      url: msg.destination,
      body: msg.body,
      delay: msg.delay,
      retries: msg.retries ?? 3,
      deduplicationId: msg.deduplicationId,
    });

    return { messageId: result.messageId };
  } catch (err) {
    console.error("[Queue] Publish error:", err);
    throw err;
  }
}

/**
 * Publish to a named topic (fan-out to multiple subscribers).
 */
export async function publishToTopic(
  topic: string,
  body: Record<string, unknown>,
  opts?: { delay?: number; retries?: number }
): Promise<void> {
  const client = getQStash();
  if (!client) {
    console.warn("[Queue] QStash not configured, skipping topic publish");
    return;
  }

  try {
    await client.publishJSON({
      topic,
      body,
      delay: opts?.delay,
      retries: opts?.retries ?? 3,
    });
  } catch (err) {
    console.error("[Queue] Topic publish error:", err);
    throw err;
  }
}

// Pre-built queue helpers for common portal events
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export async function queueSendEmail(payload: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  await publishMessage({
    destination: `${BASE_URL}/api/portal/queue/send-email`,
    body: payload,
    retries: 3,
  });
}

export async function queueCreateSalesforceCase(payload: {
  contactId: string;
  subject: string;
  description: string;
  origin: string;
}): Promise<void> {
  await publishMessage({
    destination: `${BASE_URL}/api/portal/queue/salesforce-case`,
    body: payload,
    retries: 3,
  });
}

export async function queueRetellSmsInit(payload: {
  phone: string;
  patientName: string;
  athenaPatientId: string;
}): Promise<void> {
  await publishMessage({
    destination: `${BASE_URL}/api/portal/retell/start-sms`,
    body: payload,
    retries: 2,
  });
}

export { getQStash };
