/**
 * Client-side helpers for the no-account portal registration flow.
 *
 * All helpers are safe to import from any "use client" component. None of them
 * touch localStorage — the regToken is the only thing we persist, and we keep
 * it in sessionStorage so it dies with the tab.
 */

const REG_TOKEN_KEY = "hh_reg_token";
const REG_PATIENT_KEY = "hh_reg_patient_id";
const REG_HINT_KEY = "hh_reg_hint_patient_id";
const REG_CONTACT_KEY = "hh_reg_contact";
const REG_INSURANCE_KEY = "hh_reg_insurance";

// Per-step "draft" payloads. Each registration step persists its in-progress
// form fields under one of these keys so the user can hit the browser Back
// button (or our in-app Back link) without losing what they typed. The keys
// are intentionally namespaced under `hh_reg_draft_*` so `clearRegistration`
// can wipe them in one pass.
const REG_DRAFT_KEYS = {
  demographics: "hh_reg_draft_demographics",
  eligibility: "hh_reg_draft_eligibility",
  schedule: "hh_reg_draft_schedule",
} as const;

type RegDraftStep = keyof typeof REG_DRAFT_KEYS;

export interface StoredContact {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

/**
 * Insurance selection captured during the eligibility step. Persisted so
 * the membership / schedule steps know whether the registrant is on a
 * government-funded plan (and therefore not eligible for membership).
 */
export interface StoredInsurance {
  insurancepackageid: number;
  insuranceplanname: string;
  insuranceId?: string;
  isGovernmentFunded: boolean;
  governmentFundedType?: string | null;
}

export interface StoredRegistration extends StoredContact {
  regToken: string;
  patientId: string;
  hintPatientId?: string;
  insurance?: StoredInsurance;
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveRegistration(reg: StoredRegistration): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(REG_TOKEN_KEY, reg.regToken);
    s.setItem(REG_PATIENT_KEY, reg.patientId);
    if (reg.hintPatientId) s.setItem(REG_HINT_KEY, reg.hintPatientId);
    else s.removeItem(REG_HINT_KEY);

    const contact: StoredContact = {
      firstName: reg.firstName,
      lastName: reg.lastName,
      email: reg.email,
      phone: reg.phone,
    };
    if (Object.values(contact).some(Boolean)) {
      s.setItem(REG_CONTACT_KEY, JSON.stringify(contact));
    }
  } catch {
    // Ignore — Safari private mode etc.
  }
}

export function loadRegistration(): StoredRegistration | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const regToken = s.getItem(REG_TOKEN_KEY);
    const patientId = s.getItem(REG_PATIENT_KEY);
    if (!regToken || !patientId) return null;
    let contact: StoredContact = {};
    const rawContact = s.getItem(REG_CONTACT_KEY);
    if (rawContact) {
      try {
        contact = JSON.parse(rawContact) as StoredContact;
      } catch {
        contact = {};
      }
    }
    let insurance: StoredInsurance | undefined;
    const rawInsurance = s.getItem(REG_INSURANCE_KEY);
    if (rawInsurance) {
      try {
        insurance = JSON.parse(rawInsurance) as StoredInsurance;
      } catch {
        insurance = undefined;
      }
    }
    return {
      regToken,
      patientId,
      hintPatientId: s.getItem(REG_HINT_KEY) || undefined,
      insurance,
      ...contact,
    };
  } catch {
    return null;
  }
}

/**
 * Persist (or replace) the registrant's selected insurance for the rest of
 * the wizard. Pass `null` to clear it.
 */
export function saveRegistrationInsurance(
  insurance: StoredInsurance | null
): void {
  const s = safeStorage();
  if (!s) return;
  try {
    if (insurance) {
      s.setItem(REG_INSURANCE_KEY, JSON.stringify(insurance));
    } else {
      s.removeItem(REG_INSURANCE_KEY);
    }
  } catch {
    // Ignore — Safari private mode etc.
  }
}

export function clearRegistration(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(REG_TOKEN_KEY);
    s.removeItem(REG_PATIENT_KEY);
    s.removeItem(REG_HINT_KEY);
    s.removeItem(REG_CONTACT_KEY);
    s.removeItem(REG_INSURANCE_KEY);
    for (const key of Object.values(REG_DRAFT_KEYS)) {
      s.removeItem(key);
    }
  } catch {
    // Ignore.
  }
}

/**
 * Persist the in-progress form payload for a given registration step. We
 * intentionally store under sessionStorage (not localStorage) so the draft
 * disappears with the tab — registration is not meant to span sessions.
 *
 * Pass `null` to clear the draft (e.g. after the user successfully completes
 * that step and we don't want stale fields lingering).
 */
export function saveRegistrationDraft<T>(
  step: RegDraftStep,
  draft: T | null
): void {
  const s = safeStorage();
  if (!s) return;
  try {
    const key = REG_DRAFT_KEYS[step];
    if (draft === null || draft === undefined) {
      s.removeItem(key);
    } else {
      s.setItem(key, JSON.stringify(draft));
    }
  } catch {
    // Ignore — Safari private mode etc.
  }
}

/**
 * Load the persisted draft for a registration step, if any. Returns `null`
 * when no draft is stored or the stored value can't be parsed.
 *
 * Callers should treat the result as a partial of their form shape and
 * defensively merge it onto their initial defaults — the stored payload may
 * be from an older deploy with a different schema.
 */
export function loadRegistrationDraft<T>(step: RegDraftStep): T | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(REG_DRAFT_KEYS[step]);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface RegisterFetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: { error: string; reason?: string; code?: string;[k: string]: unknown };
}

/**
 * fetch wrapper for the registration namespace. Adds the regToken bearer header
 * when present, parses JSON safely (no throw on HTML/empty bodies), and surfaces
 * a normalized error object.
 *
 * If the regToken is invalid/expired, clears local registration state so the
 * caller can redirect back to the start of the wizard.
 */
export async function registerFetch<T>(
  url: string,
  init?: RequestInit
): Promise<RegisterFetchResult<T>> {
  const reg = loadRegistration();
  const headers = new Headers(init?.headers || {});
  if (reg?.regToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${reg.regToken}`);
  }
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: { error: "Network error. Please try again." },
    };
  }

  let parsed: unknown = null;
  try {
    const text = await res.text();
    if (text.trim()) parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (res.status === 401 && (parsed as { reason?: string } | null)?.reason) {
    clearRegistration();
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error:
        (parsed as { error: string } | null) ?? {
          error: `Request failed (${res.status})`,
        },
    };
  }

  return { ok: true, status: res.status, data: (parsed as T) ?? null };
}
