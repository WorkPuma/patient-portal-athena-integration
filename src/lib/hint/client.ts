/**
 * HINT Health API Client (TypeScript)
 *
 * API key authentication for HINT Health membership platform.
 * Reference: prefect/docs/HINT-MEMBERSHIP.md
 *
 * Required env vars:
 * - HINT_API_KEY: Practice API key
 * - HINT_BASE_URL (default: https://api.hint.com)
 */

const HINT_BASE_URL = process.env.HINT_BASE_URL || "https://api.hint.com";
const HINT_API_KEY = process.env.HINT_API_KEY;

export class HintApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody: string
  ) {
    super(message);
    this.name = "HintApiError";
  }
}

async function hintRequest<T = Record<string, unknown>>(
  method: string,
  endpoint: string,
  options?: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
  }
): Promise<T> {
  if (!HINT_API_KEY) {
    throw new Error("HINT_API_KEY is required");
  }

  const url = new URL(endpoint, HINT_BASE_URL);

  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${HINT_API_KEY}`,
    Accept: "application/json",
  };

  let body: string | undefined;
  if (options?.body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url.toString(), { method, headers, body });

  if (!response.ok) {
    const text = await response.text();
    throw new HintApiError(
      `HINT API ${method} ${endpoint} failed (${response.status}): ${text}`,
      response.status,
      text
    );
  }

  const text = await response.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HintPatient {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  date_of_birth?: string;
  membership_status?: string;
  created_at: string;
  updated_at: string;
  account?: { name: string; past_due_in_cents: number };
  memberships?: Array<{
    enrollment_status: string;
    member_type: string;
    start_date: string;
    end_date?: string | null;
    status: string;
    plan: { id: string; name: string; plan_type: string };
    payer?: { id: string; name: string };
  }>;
  practitioner?: {
    id: string;
    name: string;
    [key: string]: unknown;
  };
  location?: {
    id: string;
    name: string;
    address_line1?: string;
    address_city?: string;
    address_state?: string;
    address_zip?: string;
    phone_number?: string;
    [key: string]: unknown;
  };
  phones?: Array<{ number: string; type: string }>;
  [key: string]: unknown;
}

export interface HintMembership {
  id: string;
  patient_id: string;
  plan_id: string;
  plan_name: string;
  status: "active" | "cancelled" | "past_due" | "pending" | "trialing";
  start_date: string;
  end_date?: string;
  next_billing_date?: string;
  amount_cents: number;
  balance_cents: number;
  created_at: string;
  [key: string]: unknown;
}

export interface HintInvoice {
  id: string;
  patient_id: string;
  membership_id?: string;
  amount_cents: number;
  balance_cents: number;
  status: "paid" | "unpaid" | "partially_paid" | "void" | "refunded";
  due_date: string;
  paid_date?: string;
  description?: string;
  created_at: string;
  [key: string]: unknown;
}

export interface HintPlan {
  id: string;
  name: string;
  amount_cents: number;
  interval: "month" | "year";
  description?: string;
  [key: string]: unknown;
}

// ─── Patient Operations ──────────────────────────────────────────────────────

export async function getPatients(options?: {
  updatedSince?: string;
  page?: number;
  perPage?: number;
}): Promise<HintPatient[]> {
  return hintRequest<HintPatient[]>("GET", "/api/provider/patients", {
    params: {
      updated_since: options?.updatedSince,
      page: options?.page,
      per_page: options?.perPage ?? 100,
    },
  });
}

export async function getPatient(patientId: string): Promise<HintPatient> {
  return hintRequest<HintPatient>(
    "GET",
    `/api/provider/patients/${patientId}`
  );
}

/**
 * Create a Hint patient.
 *
 * Payload shape verified against the production Prefect outbound sync
 * (prefect/prefect-jobs/hint_outbound_patient_sync.py):
 *   - flat body (no `{patient:...}` wrapper)
 *   - field is `dob` (YYYY-MM-DD), NOT `date_of_birth`
 *   - phones is an array: `[{ number: "5551234567", type: "mobile" }]`
 *   - phone digits are the trailing 10 of any E.164/raw input
 *
 * The previous shape (`{patient: {date_of_birth, phone}}`) returned 422 from
 * Hint with an error body referring to the missing required `dob` field —
 * burning a real Hint patient slot every time we got close. Don't change
 * this without re-running the BFF E2E script against the same key.
 */
export async function createPatient(params: {
  first_name: string;
  last_name: string;
  email: string;
  /** YYYY-MM-DD. Hint rejects empty strings or any other format. */
  dob: string;
  /** Optional address fields — Hint accepts them on create. */
  address_line1?: string;
  address_line2?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  /** E.164 or raw US phone — we normalise to digits + take last 10. */
  phone?: string;
}): Promise<HintPatient> {
  const payload: Record<string, unknown> = {
    first_name: params.first_name,
    last_name: params.last_name,
    email: params.email,
    dob: params.dob,
  };
  if (params.address_line1) payload.address_line1 = params.address_line1;
  if (params.address_line2) payload.address_line2 = params.address_line2;
  if (params.address_city) payload.address_city = params.address_city;
  if (params.address_state) payload.address_state = params.address_state;
  if (params.address_zip) payload.address_zip = params.address_zip;
  if (params.phone) {
    const digits = params.phone.replace(/\D/g, "");
    if (digits.length >= 10) {
      payload.phones = [{ number: digits.slice(-10), type: "mobile" }];
    }
  }
  return hintRequest<HintPatient>("POST", "/api/provider/patients", {
    body: payload,
  });
}

export async function updatePatient(
  patientId: string,
  params: Partial<{
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
  }>
): Promise<HintPatient> {
  return hintRequest<HintPatient>(
    "PATCH",
    `/api/provider/patients/${patientId}`,
    { body: { patient: params } }
  );
}

// ─── Payment Method Operations (Rainforest tokenization) ───────────────────
//
// Hint partners with Rainforest for PCI-compliant card / ACH tokenization. We
// never see raw card numbers — the Rainforest web component (`<rainforest-payment>`)
// renders inside our page, tokenizes the input directly to Rainforest's
// servers, and emits an `approved` event with a `payment_method_id`. We then
// POST that token to Hint, which stores it against the patient and uses it for
// membership billing.
//
// Endpoint paths verified live against api.hint.com (2026-04-18):
//   POST /api/provider/patients/{id}/payment_methods/setup -> Rainforest session
//   GET  /api/provider/patients/{id}/payment_methods       -> stored methods
//   POST /api/provider/patients/{id}/payment_methods       -> attach by rainforest_id
//
// Reference: https://developers.hint.com/docs/collecting-payment-information-hint-payments

export interface HintPaymentMethodSetup {
  payment_processor: string; // "rainforest"
  payment_method_config_id: string; // pmc_…
  session_key: string; // session_…
  allowed_methods: string; // "CARD,ACH,VALIDATED_ACH"
}

export interface HintPaymentMethod {
  id: string; // bnk-… or card-…
  default?: boolean;
  last_four?: string;
  name?: string; // e.g. "Visa", "Bank of America NA"
  type?: "card" | "bank_account" | string;
  bank_account?: {
    id: string;
    last_four?: string;
    name?: string;
    type?: string;
    [k: string]: unknown;
  } | null;
  card?: {
    id: string;
    card_type?: string;
    exp_month?: number;
    exp_year?: number;
    last_four?: string;
    name?: string;
    type?: string;
    [k: string]: unknown;
  } | null;
  [k: string]: unknown;
}

export async function createPaymentMethodSetup(
  patientId: string,
  options?: {
    accepts_bank?: boolean;
    user_is_owner?: boolean;
  }
): Promise<HintPaymentMethodSetup> {
  return hintRequest<HintPaymentMethodSetup>(
    "POST",
    `/api/provider/patients/${patientId}/payment_methods/setup`,
    {
      body: {
        accepts_bank: options?.accepts_bank ?? true,
        user_is_owner: options?.user_is_owner ?? true,
      },
    }
  );
}

export async function listPaymentMethods(
  patientId: string
): Promise<HintPaymentMethod[]> {
  return hintRequest<HintPaymentMethod[]>(
    "GET",
    `/api/provider/patients/${patientId}/payment_methods`
  );
}

export async function attachPaymentMethod(
  patientId: string,
  params: { rainforest_id: string; default?: boolean }
): Promise<HintPaymentMethod> {
  return hintRequest<HintPaymentMethod>(
    "POST",
    `/api/provider/patients/${patientId}/payment_methods`,
    {
      body: {
        rainforest_id: params.rainforest_id,
        default: params.default ?? true,
      },
    }
  );
}

// ─── Membership Operations ───────────────────────────────────────────────────

export async function getMemberships(options?: {
  patientId?: string;
  status?: string;
}): Promise<HintMembership[]> {
  return hintRequest<HintMembership[]>("GET", "/api/provider/memberships", {
    params: {
      patient_id: options?.patientId,
      status: options?.status,
    },
  });
}

export async function getMembership(
  membershipId: string
): Promise<HintMembership> {
  return hintRequest<HintMembership>(
    "GET",
    `/api/provider/memberships/${membershipId}`
  );
}

/**
 * Create a new membership for a patient.
 *
 * Hint's `POST /api/provider/memberships` schema is finicky: the OpenAPI doc
 * shows `MembershipCreateSanitizer` with `membership_patients`, `plan`, etc.
 * but in practice the API also requires an `owner: { id }` field at the top
 * level — without it Hint returns
 *   `404 "Couldn't find Patient without an ID"`.
 *
 * For self-service retail enrollment the primary subscriber is sent as
 * `member_type: "spouse"` per Hint's note: "all adults may be sent as
 * 'spouse' (naming convention may be updated in the future)".
 *
 * `period_in_months` matches the plan cadence: 1 = monthly, 12 = annual.
 */
export async function enrollMember(params: {
  patient_id: string;
  plan_id: string;
  start_date?: string;
  period_in_months?: 1 | 3 | 6 | 12;
}): Promise<HintMembership> {
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    owner: { id: params.patient_id },
    membership_patients: [
      {
        patient: { id: params.patient_id },
        member_type: "spouse",
      },
    ],
    plan: { id: params.plan_id },
    start_date: params.start_date ?? today,
    period_in_months: params.period_in_months ?? 1,
  };
  return hintRequest<HintMembership>("POST", "/api/provider/memberships", {
    body: payload,
  });
}

export async function cancelMembership(
  membershipId: string,
  params?: {
    cancellation_reason?: string;
    cancel_at_period_end?: boolean;
  }
): Promise<HintMembership> {
  return hintRequest<HintMembership>(
    "PATCH",
    `/api/provider/memberships/${membershipId}/cancel`,
    {
      body: {
        cancellation_reason: params?.cancellation_reason,
        cancel_at_period_end: params?.cancel_at_period_end ?? true,
      },
    }
  );
}

export async function renewMembership(
  membershipId: string,
  params?: { plan_id?: string }
): Promise<HintMembership> {
  return hintRequest<HintMembership>(
    "PATCH",
    `/api/provider/memberships/${membershipId}/renew`,
    { body: params ?? {} }
  );
}

// ─── Invoice Operations ──────────────────────────────────────────────────────

export async function getInvoices(options?: {
  patientId?: string;
  status?: string;
  page?: number;
}): Promise<HintInvoice[]> {
  return hintRequest<HintInvoice[]>("GET", "/api/provider/invoices", {
    params: {
      patient_id: options?.patientId,
      status: options?.status,
      page: options?.page,
    },
  });
}

export async function getInvoice(invoiceId: string): Promise<HintInvoice> {
  return hintRequest<HintInvoice>(
    "GET",
    `/api/provider/invoices/${invoiceId}`
  );
}

export async function payInvoice(
  invoiceId: string,
  params?: { amount_cents?: number }
): Promise<HintInvoice> {
  return hintRequest<HintInvoice>(
    "POST",
    `/api/provider/invoices/${invoiceId}/pay`,
    { body: params ?? {} }
  );
}

// ─── Plan Operations ─────────────────────────────────────────────────────────

export async function getPlans(): Promise<HintPlan[]> {
  return hintRequest<HintPlan[]>("GET", "/api/provider/plans");
}

// ─── Signup Attempts ─────────────────────────────────────────────────────────

export interface HintSignupAttempt {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export async function getSignupAttempts(): Promise<HintSignupAttempt[]> {
  return hintRequest<HintSignupAttempt[]>(
    "GET",
    "/api/provider/signup_attempts"
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function isMembershipActive(membership: HintMembership): boolean {
  return membership.status === "active" || membership.status === "trialing";
}

export function isWithin30DayGuarantee(membership: HintMembership): boolean {
  const startDate = new Date(membership.start_date);
  const now = new Date();
  const daysSinceStart =
    (now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceStart <= 30;
}
