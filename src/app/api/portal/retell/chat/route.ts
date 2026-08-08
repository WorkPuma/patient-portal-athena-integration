/**
 * POST /api/portal/retell/chat
 *
 * Driver for the in-portal text-chat assistant ("Dot"). Owns the Retell
 * /create-chat lifecycle: spins up a chat session against the Dot agent
 * (RETELL_REGISTRATION_AGENT_ID) on the first turn, then forwards each
 * subsequent user message to /create-chat-completion and returns the
 * assistant reply to the widget.
 *
 * The widget primes us with a `context` payload on the first turn —
 * pathname, locale, and (when the user is mid-registration) anything
 * we already know from `loadRegistration()`. We forward that as Retell
 * `custom_attributes` so Dot can greet the patient by name and skip
 * fields they've already filled in upstream.
 *
 * Output contract: Dot is prompted (see scripts/setup-retell-
 * registration-agent.ts) to occasionally append an `OPTIONS:` JSON tail
 * to its reply containing 1-4 quick-reply chips the widget should
 * render under the message. We strip that tail from the user-visible
 * text and surface the parsed chips in the JSON response.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPortalFeatureFlags } from "@/lib/portal/feature-flags";
import { captureServerEvent } from "@/lib/posthog/server";
import { hashToOpaqueDistinctId } from "@/lib/posthog/sanitize";
import { rateLimit, rateLimitHeaders } from "@/lib/rate-limit";

interface ChatPayload {
  message?: string;
  chatId?: string;
  metadata?: Record<string, string>;
  /** Optional first-turn priming context from the widget. */
  context?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    pathname?: string;
    /** Free-form notes the widget wants the agent to consider. */
    notes?: string;
  };
}

interface RetellChatResponse {
  chat_id?: string;
  messages?: Array<{ role?: string; content?: string }>;
  content?: string;
  response?: string;
}

interface AssistantQuickReply {
  label: string;
  value: string;
}

interface ParsedAssistant {
  text: string;
  options: AssistantQuickReply[];
  /** Field hint when the bot is asking for typed input ("phone", "email"…). */
  requestField: string | null;
}

function parsePayload(body: unknown): ChatPayload {
  if (!body || typeof body !== "object") return {};
  return body as ChatPayload;
}

async function retellRequest<T>(
  path: string,
  payload: Record<string, unknown>
): Promise<T> {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    throw new Error("RETELL_API_KEY is not configured");
  }

  const baseUrl = process.env.RETELL_API_BASE_URL || "https://api.retellai.com";
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Retell error ${response.status}: ${detail}`);
  }

  return response.json() as Promise<T>;
}

function pickAgentId(): string | undefined {
  // Dedicated registration agent (Dot) when configured. Falls through
  // to the legacy SMS scheduling agent so existing deployments keep
  // working until the operator runs `npm run dot:setup` and sets
  // RETELL_REGISTRATION_AGENT_ID.
  return (
    process.env.RETELL_REGISTRATION_AGENT_ID ||
    process.env.RETELL_CHAT_AGENT_ID ||
    process.env.RETELL_SMS_AGENT_ID ||
    undefined
  );
}

function rawAssistantContent(data: RetellChatResponse): string {
  const assistant = data.messages
    ?.slice()
    .reverse()
    .find(
      (item) =>
        (item.role === "agent" || item.role === "assistant") && item.content
    );
  return (
    assistant?.content ||
    data.content ||
    data.response ||
    "I can help with registration and scheduling. How can I help next?"
  );
}

/**
 * Strip the optional `OPTIONS:` JSON tail Dot is prompted to append.
 * Accepts either an inline JSON object on the last line, or a fenced
 * ```json block — whichever the model decides to emit. Failures fall
 * back to the raw assistant text with no chips, so a malformed tail
 * never breaks the conversation.
 */
function parseAssistant(content: string): ParsedAssistant {
  const trimmed = content.trim();

  // Try fenced JSON block at the very end first (most robust against
  // free-form sentences containing curly braces).
  const fence = trimmed.match(
    /([\s\S]*?)\n```json\s*\n([\s\S]+?)\n```\s*$/i
  );
  if (fence) {
    const tail = safeParse(fence[2]);
    if (tail) {
      return {
        text: fence[1].trim(),
        options: normalizeOptions(tail.options),
        requestField: typeof tail.requestField === "string" ? tail.requestField : null,
      };
    }
  }

  // Inline `OPTIONS: {...}` on the last line.
  const inline = trimmed.match(/([\s\S]*?)\n\s*OPTIONS:\s*(\{[\s\S]+\})\s*$/i);
  if (inline) {
    const tail = safeParse(inline[2]);
    if (tail) {
      return {
        text: inline[1].trim(),
        options: normalizeOptions(tail.options),
        requestField: typeof tail.requestField === "string" ? tail.requestField : null,
      };
    }
  }

  // Naked trailing JSON object (the LLM occasionally drops the prefix).
  const naked = trimmed.match(/([\s\S]*?)\n(\{[\s\S]*"options"[\s\S]*\})\s*$/);
  if (naked) {
    const tail = safeParse(naked[2]);
    if (tail) {
      return {
        text: naked[1].trim(),
        options: normalizeOptions(tail.options),
        requestField: typeof tail.requestField === "string" ? tail.requestField : null,
      };
    }
  }

  return { text: trimmed, options: [], requestField: null };
}

function safeParse(s: string): { options?: unknown; requestField?: unknown } | null {
  try {
    return JSON.parse(s) as { options?: unknown; requestField?: unknown };
  } catch {
    return null;
  }
}

function normalizeOptions(raw: unknown): AssistantQuickReply[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantQuickReply[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ label: item, value: item });
    } else if (item && typeof item === "object") {
      const r = item as Record<string, unknown>;
      const label = String(r.label ?? r.text ?? r.value ?? "").trim();
      const value = String(r.value ?? r.label ?? "").trim();
      if (label && value) out.push({ label, value });
    }
    if (out.length >= 6) break;
  }
  return out;
}

function buildCustomAttributes(payload: ChatPayload): Record<string, string> {
  const ctx = payload.context ?? {};
  const merged: Record<string, string> = {};
  // Strings only — Retell rejects nested objects in custom_attributes.
  for (const [k, v] of Object.entries({ ...(payload.metadata ?? {}), ...ctx })) {
    if (v === undefined || v === null) continue;
    merged[k] = String(v);
  }
  // Always tag the conversation so the webhook can route correctly.
  merged.source = merged.source || "portal_register_widget";
  merged.agent_persona = "dot";
  return merged;
}

function buildPrimingMessage(ctx: ChatPayload["context"]): string | undefined {
  if (!ctx) return undefined;
  const parts: string[] = [];
  if (ctx.firstName || ctx.lastName) {
    parts.push(
      `The patient is ${[ctx.firstName, ctx.lastName].filter(Boolean).join(" ")}.`
    );
  }
  if (ctx.email) parts.push(`Email: ${ctx.email}.`);
  if (ctx.phone) parts.push(`Phone: ${ctx.phone}.`);
  if (ctx.pathname) parts.push(`Page: ${ctx.pathname}.`);
  if (ctx.notes) parts.push(ctx.notes);
  if (parts.length === 0) return undefined;
  return `[context]\n${parts.join(" ")}\nUse this context to skip questions you already have answers to.`;
}

export async function POST(request: NextRequest) {
  // Defense-in-depth: even if the widget mount is gated in (portal)/layout.tsx,
  // the route stays publicly reachable. Fail closed when Dot is disabled so a
  // direct hit (or stale browser tab) cannot drive a Retell session.
  if (!getPortalFeatureFlags().dot) {
    return NextResponse.json(
      { disabled: true, error: "Dot is disabled in this environment." },
      { status: 503 }
    );
  }
  // Abuse control (DEV-4472): per-IP fail-closed limit on Retell chat turns
  // to bound cost (each turn calls the Retell LLM API). Fail-closed so a
  // limiter outage does not open the tap.
  const rl = await rateLimit(request, {
    limit: 20,
    window: "1m",
    prefix: "portal-retell-chat",
    failClosed: true,
  });
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many messages. Please slow down and try again shortly." },
      { status: 429, headers: rateLimitHeaders(rl) }
    );
  }
  try {
    const payload = parsePayload(await request.json());
    const message = payload.message?.trim();
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const agentId = pickAgentId();
    if (!agentId) {
      return NextResponse.json(
        { error: "Retell chat agent is not configured" },
        { status: 503 }
      );
    }

    let chatId = payload.chatId?.trim() || "";

    if (!chatId) {
      const created = await retellRequest<RetellChatResponse>("/create-chat", {
        agent_id: agentId,
        retell_llm_dynamic_variables: payload.context ?? {},
        metadata: payload.metadata ?? {},
        custom_attributes: buildCustomAttributes(payload),
      });
      chatId = created.chat_id || "";

      // Prime the new session with a context message so Dot greets the
      // patient using what we already know. Retell discards a prefix
      // user-turn that's clearly a system note (we tag it `[context]`),
      // and a second `/create-chat-completion` is a no-op cost-wise.
      const priming = buildPrimingMessage(payload.context);
      if (chatId && priming) {
        try {
          await retellRequest<RetellChatResponse>("/create-chat-completion", {
            chat_id: chatId,
            content: priming,
          });
        } catch {
          // Non-fatal — if priming fails Dot just won't have the
          // pre-known fields, but the conversation will still work.
        }
      }
    }

    if (!chatId) {
      throw new Error("Retell did not return a chat_id");
    }

    const completionStart = Date.now();
    const completion = await retellRequest<RetellChatResponse>(
      "/create-chat-completion",
      {
        chat_id: chatId,
        content: message,
      }
    );
    const latencySeconds = (Date.now() - completionStart) / 1000;

    try {
      const distinctId = await hashToOpaqueDistinctId(chatId);
      await captureServerEvent(distinctId, "$ai_generation", {
        $ai_trace_id: chatId,
        $ai_span_name: "dot_chat_turn",
        $ai_model: "gpt-4.1",
        $ai_provider: "openai",
        $ai_latency: latencySeconds,
        $ai_base_url: "https://api.retellai.com",
      });
    } catch {
      // analytics never blocks the response
    }

    const parsed = parseAssistant(rawAssistantContent(completion));
    return NextResponse.json({
      chatId,
      message: parsed.text,
      options: parsed.options,
      requestField: parsed.requestField,
    });
  } catch (error) {
    console.error("[portal/retell/chat] failed", error);

    // Surface error-state generations to PostHog so failure rates are visible.
    // We don't have a chatId here if the error happened before session creation,
    // so this is best-effort only.
    return NextResponse.json(
      {
        error:
          "The assistant is temporarily unavailable. Please choose Talk to a person now.",
      },
      { status: 502 }
    );
  }
}
