/**
 * Pure helpers shared by `PortalChatWidget` and its tests. Keeping these in
 * a sibling module (rather than inside the `"use client"` component) lets us
 * cover the validation and copy in plain unit tests without dragging in
 * React or Next.js.
 *
 * The widget renders Dot, our portal registration assistant. We name the
 * agent for familiarity ("Hi, I'm Dot...") so users have a hook to refer
 * back to and so the brand voice stays consistent across copy surfaces.
 */

export interface HandoffFormSnapshot {
  firstName: string;
  lastName: string;
  email: string;
  /**
   * Phone is required when the patient asks to talk to a person. This is a
   * deliberate UX decision — a callback request without a callback number
   * forces our staff to hunt through Salesforce for an alternate, which
   * delays patient response.
   */
  phone: string;
}

export const ASSISTANT_NAME = "Dot";

export const INITIAL_MESSAGE =
  `Hi, I'm ${ASSISTANT_NAME} — your registration assistant. I can answer ` +
  `quick questions, help you finish registering, or schedule your first ` +
  `visit. If you'd rather talk to a person, I can connect you right away.`;

/**
 * First-turn quick-reply chips so the patient doesn't have to figure out
 * what to type. These are wired straight into the assistant flow as if
 * the user had typed them — the goal is to lower the friction of the
 * empty composer.
 */
export interface IntentOption {
  id: string;
  /** Visible chip label. */
  label: string;
  /** Message text we send to Dot when the chip is tapped. */
  value: string;
}

export const INTENT_OPTIONS: IntentOption[] = [
  {
    id: "schedule",
    label: "Schedule my first visit",
    value: "I'd like to schedule my first visit.",
  },
  {
    id: "insurance",
    label: "Do you take my insurance?",
    value: "Do you take my insurance?",
  },
  {
    id: "registration",
    label: "Help me finish registering",
    value: "Help me finish registering.",
  },
  {
    id: "human",
    label: "Talk to a person",
    value: "Please connect me with a person.",
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Liberal — we just want to catch obvious typos here. Final E.164 is enforced
// server-side in /api/portal/register/handoff.
const PHONE_DIGIT_RE = /\d/g;

export function isValidHandoffEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function isValidHandoffPhone(phone: string): boolean {
  const digits = (phone.match(PHONE_DIGIT_RE) ?? []).length;
  // 10 digit US, 11 digit US (with country code), or international up to 15.
  return digits >= 10 && digits <= 15;
}

export interface HandoffValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate the callback form before we POST to /handoff. We return the
 * first failure as a user-friendly string so the widget can surface it
 * without rewriting copy.
 */
export function validateHandoff(form: HandoffFormSnapshot): HandoffValidation {
  const firstName = form.firstName.trim();
  const lastName = form.lastName.trim();
  const email = form.email.trim();
  const phone = form.phone.trim();

  if (!firstName || !lastName) {
    return { ok: false, error: "Please share your first and last name." };
  }
  if (!email) {
    return { ok: false, error: "Please share an email so we can follow up." };
  }
  if (!isValidHandoffEmail(email)) {
    return { ok: false, error: "That email address looks off — please double-check." };
  }
  if (!phone) {
    return {
      ok: false,
      error: "A phone number is required so our team can reach you.",
    };
  }
  if (!isValidHandoffPhone(phone)) {
    return { ok: false, error: "Please enter a valid phone number." };
  }
  return { ok: true };
}

export function toUserSummary(form: HandoffFormSnapshot): string {
  const parts = [
    `${form.firstName} ${form.lastName}`.trim(),
    form.email.trim(),
    form.phone.trim(),
  ].filter(Boolean);
  return `Talk to a person: ${parts.join(" · ")}`;
}
