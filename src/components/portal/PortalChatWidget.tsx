"use client";

/**
 * Portal Chat Widget — "Dot"
 *
 * Slide-in chat surface that lives on the public registration pages and
 * drives Dot, our Retell AI registration assistant. The widget is the
 * only patient-facing entry point for two flows that used to live in
 * separate modals:
 *
 *  - Conversational Q&A + end-to-end registration & scheduling, driven
 *    by /api/portal/retell/chat → Retell agent → registration tools.
 *  - Human handoff via /api/portal/register/handoff, which creates a
 *    Salesforce Lead during business hours / queues a callback otherwise.
 *
 * Design highlights:
 *  - Hydration-safe: gated on a mounted flag so SSR and the first
 *    client render are identical (avoids React #418 from
 *    `usePathname()` returning the rewritten path on the server).
 *  - Inline option chips: when Dot returns an `options` array (parsed
 *    from her response tail by the chat route), we render those as
 *    quick-reply buttons under her message. Tapping one auto-sends.
 *  - Typing indicator: animated dots show while we await a reply so
 *    patients aren't staring at silence.
 *  - Phone is REQUIRED on callback requests — without it the team
 *    can't reach the patient and the callback queue stalls.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquare, Send, Sparkles, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { loadRegistration } from "@/components/portal/registration/registration-client";
import {
  ASSISTANT_NAME,
  INITIAL_MESSAGE,
  INTENT_OPTIONS,
  toUserSummary,
  validateHandoff,
  type IntentOption,
} from "@/components/portal/portal-chat-widget-helpers";

interface QuickReply {
  label: string;
  value: string;
}

interface Message {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Quick-reply chips Dot suggested for this turn. */
  options?: QuickReply[];
}

type FlowState = "choice" | "assistant" | "handoff_form" | "handoff_result";

interface HandoffFormState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const INITIAL_MESSAGE_ID = "intro-0";

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function PortalChatWidget() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [isOpen, setIsOpen] = useState(false);
  const [flow, setFlow] = useState<FlowState>("choice");
  const [chatId, setChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: INITIAL_MESSAGE_ID,
      role: "assistant",
      text: INITIAL_MESSAGE,
      options: INTENT_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
    },
  ]);
  const [handoffForm, setHandoffForm] = useState<HandoffFormState>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });

  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const onRegisterPage = useMemo(
    () => pathname?.startsWith("/register") ?? false,
    [pathname]
  );

  // Pre-fill the handoff form (and prime Dot) with whatever the patient
  // already typed into the registration wizard. We do this on every open
  // so reopening the widget mid-flow picks up new fields.
  useEffect(() => {
    const reg = loadRegistration();
    if (!reg) return;
    setHandoffForm((prev) => ({
      firstName: reg.firstName || prev.firstName,
      lastName: reg.lastName || prev.lastName,
      email: reg.email || prev.email,
      phone: reg.phone || prev.phone,
    }));
  }, [isOpen]);

  // Auto-scroll on new messages / typing state.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  function pushMessage(
    role: Message["role"],
    text: string,
    options?: QuickReply[]
  ) {
    setMessages((prev) => [...prev, { id: makeId(), role, text, options }]);
  }

  function buildContext(): Record<string, string | undefined> {
    const reg = loadRegistration();
    return {
      firstName: reg?.firstName,
      lastName: reg?.lastName,
      email: reg?.email,
      phone: reg?.phone,
      pathname: pathname ?? undefined,
      patientId: reg?.patientId,
      hintPatientId: reg?.hintPatientId,
    };
  }

  async function sendToAssistant(message: string) {
    if (!message || loading) return;
    setError(null);
    pushMessage("user", message);
    setLoading(true);

    try {
      const response = await fetch("/api/portal/retell/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          message,
          context: buildContext(),
          metadata: {
            source: "portal_register_widget",
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `${ASSISTANT_NAME} is unavailable`);
      }

      if (data.chatId) setChatId(data.chatId);

      pushMessage(
        "assistant",
        data.message || "How else can I help?",
        Array.isArray(data.options) ? data.options : undefined
      );
    } catch (err) {
      const fallback =
        err instanceof Error
          ? err.message
          : `${ASSISTANT_NAME} is temporarily unavailable.`;
      setError(fallback);
      pushMessage(
        "assistant",
        "I can still connect you with a person now if you'd like.",
        [{ label: "Talk to a person", value: "__handoff__" }]
      );
    } finally {
      setLoading(false);
    }
  }

  function handleComposerSend() {
    const text = composerValue.trim();
    if (!text) return;
    setComposerValue("");
    void sendToAssistant(text);
  }

  function handleQuickReply(option: QuickReply | IntentOption) {
    // Special sentinel — the chip is a request to bail out to a human.
    if (option.value === "__handoff__") {
      chooseHumanHandoff();
      return;
    }
    if (flow === "choice") setFlow("assistant");
    void sendToAssistant(option.value);
  }

  function chooseAssistant() {
    setFlow("assistant");
    setError(null);
    pushMessage(
      "assistant",
      `Great — ask me anything about registering, your insurance, or scheduling your first visit. I'll keep it short.`,
      INTENT_OPTIONS.filter((o) => o.id !== "human").map((o) => ({
        label: o.label,
        value: o.value,
      }))
    );
  }

  function chooseHumanHandoff() {
    setFlow("handoff_form");
    setError(null);
    pushMessage(
      "assistant",
      "No problem — share your name, email, and a phone number, and our team will reach out."
    );
  }

  async function submitHandoff() {
    const validation = validateHandoff(handoffForm);
    if (!validation.ok) {
      setError(validation.error ?? "Please complete the form.");
      return;
    }

    const payload = {
      firstName: handoffForm.firstName.trim(),
      lastName: handoffForm.lastName.trim(),
      email: handoffForm.email.trim(),
      phone: handoffForm.phone.trim(),
      mode: "callback_request" as const,
      context: messages
        .slice(-6)
        .map((item) => `${item.role}: ${item.text}`)
        .join(" | "),
    };

    setLoading(true);
    setError(null);
    pushMessage("user", toUserSummary(handoffForm));

    try {
      const response = await fetch("/api/portal/register/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Unable to submit request");
      }

      pushMessage(
        "assistant",
        data.contactWindow?.message ||
        "Thanks — our team will reach out soon."
      );
      setFlow("handoff_result");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to submit your request.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  if (!mounted || !onRegisterPage) {
    return null;
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className={cn(
          "fixed bottom-6 right-6 z-50",
          "flex items-center gap-2 pl-3 pr-4 h-12 rounded-full",
          "bg-primary text-primary-foreground shadow-lg",
          "hover:scale-105 transition-transform",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
        aria-label={`Open ${ASSISTANT_NAME}, the Herself Health registration assistant`}
      >
        <span
          className="flex items-center justify-center w-7 h-7 rounded-full bg-white/20"
          aria-hidden="true"
        >
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">Chat with {ASSISTANT_NAME}</span>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={`${ASSISTANT_NAME}, registration assistant`}
      className={cn(
        "fixed bottom-6 right-6 z-50",
        "w-[min(420px,calc(100vw-2rem))] max-h-[min(640px,calc(100vh-2rem))]",
        "bg-card border border-border rounded-2xl shadow-2xl",
        "flex flex-col overflow-hidden animate-scale-in"
      )}
    >
      <div className="flex items-center justify-between px-4 py-3 bg-primary text-primary-foreground">
        <div className="flex items-center gap-2">
          <span
            className="flex items-center justify-center w-8 h-8 rounded-full bg-white/15"
            aria-hidden="true"
          >
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="font-semibold text-sm">{ASSISTANT_NAME}</p>
            <p className="text-[11px] opacity-80">
              Herself Health registration assistant
            </p>
          </div>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="p-1 rounded hover:bg-white/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label="Close assistant"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        ref={transcriptRef}
        className="p-3 min-h-[320px] max-h-[420px] overflow-y-auto space-y-3 bg-muted/20"
        aria-live="polite"
        aria-busy={loading}
      >
        {messages.map((message) => (
          <div key={message.id} className="space-y-2">
            <div
              className={cn(
                "rounded-2xl px-3 py-2 text-sm max-w-[88%] shadow-sm",
                message.role === "assistant"
                  ? "bg-background border border-border mr-auto"
                  : "bg-primary text-primary-foreground ml-auto"
              )}
            >
              <div className="flex items-start gap-2">
                {message.role === "assistant" ? (
                  <Sparkles
                    className="h-4 w-4 mt-0.5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                ) : (
                  <UserRound className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                )}
                <p className="whitespace-pre-wrap leading-relaxed">
                  {message.text}
                </p>
              </div>
            </div>

            {message.role === "assistant" &&
              message.options &&
              message.options.length > 0 && (
                <div className="flex flex-wrap gap-2 pl-6">
                  {message.options.map((option, idx) => (
                    <button
                      key={`${message.id}-opt-${idx}`}
                      type="button"
                      onClick={() => handleQuickReply(option)}
                      disabled={loading}
                      className={cn(
                        "px-3 py-1.5 rounded-full text-xs font-medium",
                        "border border-primary/40 text-primary bg-background",
                        "hover:bg-primary hover:text-primary-foreground transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span className="sr-only">{ASSISTANT_NAME} is typing</span>
            <span aria-hidden="true">{ASSISTANT_NAME} is typing</span>
            <span className="flex gap-1" aria-hidden="true">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" />
            </span>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-border space-y-3 bg-card">
        {flow === "choice" && (
          <div className="grid grid-cols-1 gap-2">
            <Button onClick={chooseAssistant} disabled={loading}>
              <MessageSquare className="h-4 w-4 mr-2" aria-hidden="true" />
              Chat with {ASSISTANT_NAME}
            </Button>
            <Button
              variant="outline"
              onClick={chooseHumanHandoff}
              disabled={loading}
            >
              Talk to a person
            </Button>
          </div>
        )}

        {flow === "handoff_form" && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="First name"
                value={handoffForm.firstName}
                onChange={(e) =>
                  setHandoffForm((prev) => ({
                    ...prev,
                    firstName: e.target.value,
                  }))
                }
                aria-label="First name"
              />
              <Input
                placeholder="Last name"
                value={handoffForm.lastName}
                onChange={(e) =>
                  setHandoffForm((prev) => ({
                    ...prev,
                    lastName: e.target.value,
                  }))
                }
                aria-label="Last name"
              />
            </div>
            <Input
              placeholder="Email"
              type="email"
              autoComplete="email"
              value={handoffForm.email}
              onChange={(e) =>
                setHandoffForm((prev) => ({
                  ...prev,
                  email: e.target.value,
                }))
              }
              aria-label="Email"
            />
            <Input
              placeholder="Phone (required)"
              type="tel"
              autoComplete="tel"
              value={handoffForm.phone}
              onChange={(e) =>
                setHandoffForm((prev) => ({
                  ...prev,
                  phone: e.target.value,
                }))
              }
              aria-label="Phone number (required)"
              aria-required="true"
            />
            <Button onClick={submitHandoff} disabled={loading} className="w-full">
              {loading ? "Submitting…" : "Request a call back"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setFlow("assistant");
                setError(null);
              }}
              className="w-full text-xs text-muted-foreground hover:text-foreground"
            >
              Never mind, keep chatting with {ASSISTANT_NAME}
            </button>
          </div>
        )}

        {flow === "assistant" && (
          <div className="flex gap-2">
            <Input
              placeholder={`Message ${ASSISTANT_NAME}…`}
              value={composerValue}
              onChange={(e) => setComposerValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleComposerSend();
                }
              }}
              disabled={loading}
              aria-label={`Message ${ASSISTANT_NAME}`}
            />
            <Button
              size="icon"
              onClick={handleComposerSend}
              disabled={loading || !composerValue.trim()}
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        )}

        {flow === "handoff_result" && (
          <div className="grid grid-cols-1 gap-2">
            <Button onClick={chooseAssistant} variant="outline" disabled={loading}>
              Ask {ASSISTANT_NAME} another question
            </Button>
            <Button onClick={chooseHumanHandoff} disabled={loading}>
              Update contact details
            </Button>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
