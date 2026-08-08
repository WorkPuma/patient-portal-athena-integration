/**
 * Athena Health API Client (TypeScript)
 *
 * OAuth2 client credentials authentication for AthenaHealth.
 *
 * Required env vars (see .env.example):
 * - ATHENA_BASE_URL — e.g. https://api.athenahealth.com/v1/{practice_id}
 * - ATHENA_PRACTICE_ID — your Athena practice ID
 * - ATHENA_CLIENT_ID
 * - ATHENA_CLIENT_SECRET
 *
 * Reference: https://developer.athenahealth.com
 */

const ATHENA_BASE_URL =
  process.env.ATHENA_BASE_URL ||
  "https://api.athenahealth.com/v1/REPLACE_WITH_YOUR_PRACTICE_ID";
const ATHENA_PRACTICE_ID = process.env.ATHENA_PRACTICE_ID || "REPLACE_ME";
const ATHENA_CLIENT_ID = process.env.ATHENA_CLIENT_ID;
const ATHENA_CLIENT_SECRET = process.env.ATHENA_CLIENT_SECRET;
const ATHENA_SCOPE = "athena/service/Athenanet.MDP.*";

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }

  if (!ATHENA_CLIENT_ID || !ATHENA_CLIENT_SECRET) {
    throw new Error(
      "ATHENA_CLIENT_ID and ATHENA_CLIENT_SECRET are required"
    );
  }

  const credentials = Buffer.from(
    `${ATHENA_CLIENT_ID}:${ATHENA_CLIENT_SECRET}`
  ).toString("base64");

  const tokenUrl = `${ATHENA_BASE_URL}/oauth2/v1/token`;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(ATHENA_SCOPE)}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Athena token request failed (${response.status}): ${text}`
    );
  }

  const data = await response.json();
  const expiresIn = data.expires_in || 3600;

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return tokenCache.token;
}

async function athenaRequest<T = Record<string, unknown>>(
  method: string,
  endpoint: string,
  options?: {
    params?: Record<string, string | number | boolean | undefined>;
    data?: Record<string, string | number | boolean | undefined>;
  }
): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(
    `/v1/${ATHENA_PRACTICE_ID}${endpoint}`,
    ATHENA_BASE_URL
  );

  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  let body: string | undefined;
  if (options?.data && (method === "POST" || method === "PUT")) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(options.data)) {
      if (value !== undefined) {
        formData.set(key, String(value));
      }
    }
    body = formData.toString();
  }

  const response = await fetch(url.toString(), { method, headers, body });

  if (!response.ok) {
    const text = await response.text();
    throw new AthenaApiError(
      `Athena API ${method} ${endpoint} failed (${response.status}): ${text}`,
      response.status,
      text
    );
  }

  const text = await response.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AthenaApiError(
      `Invalid JSON from Athena ${method} ${endpoint}: ${text.slice(0, 240)}`,
      response.status,
      text
    );
  }
}

/** Typed error for non-2xx Athena API responses. */
export class AthenaApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody: string
  ) {
    super(message);
    this.name = "AthenaApiError";
  }
}

// ─── Patient Types ───────────────────────────────────────────────────────────

/** Patient row returned by Athena patient search/read endpoints. */
export interface AthenaPatient {
  patientid: string;
  firstname: string;
  lastname: string;
  dob: string;
  sex?: string;
  email?: string;
  mobilephone?: string;
  homephone?: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
  score?: number;
  [key: string]: unknown;
}

/** Payload for POST /patients during portal self-registration. */
export interface CreatePatientParams {
  firstname: string;
  lastname: string;
  dob: string;
  departmentid: number;
  sex?: string;
  email?: string;
  mobilephone?: string;
  homephone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  ssn?: string;
  maritalstatus?: string;

  // ─── Demographics / consent (optional overrides) ────────────────────────────
  /** Race code from the 2.16.840.1.113883.5.104 codeset, or "declined". */
  race?: string;
  /** Ethnicity code from the 2.16.840.1.113883.5.50 codeset, or "declined". */
  ethnicitycode?: string;
  /** ISO 639-2 language code (default "eng"). */
  language6392code?: string;
  /** "true" | "false" — patient consented to voice calls (default false). */
  consenttocall?: string;
  /** "true" | "false" — patient consented to SMS (default false). */
  consenttotext?: string;
  /** "true" | "false" — enable Athena portal (default false, we use our own). */
  portalaccessgiven?: string;
  /** Mirrors departmentid; Athena uses this for some legacy queues. */
  primarydepartmentid?: number;
}

/**
 * Portal-flow demographic defaults applied on every self-serve patient
 * creation. Structurally mirrors MIDI_DEMOGRAPHIC_DEFAULTS from
 *   prefect/athena-document-recognition/flows/shared/patient_ops.py
 * but with the consent + preference posture inverted from "paper import
 * never collected consent" to "patient just walked through the portal
 * and consented to everything in the UI".
 *
 * All consent flags + all 12 contactpreference channels default to
 * "true". The wizard checkboxes are pre-ticked; a patient who wants
 * out has to explicitly uncheck them. Anything explicitly supplied on
 * CreatePatientParams wins over the defaults.
 *
 * NOTE: portalaccessgiven stays "false" because we don't use Athena's
 * patient portal — patients log into our own portal via Clerk. Setting
 * it true triggers Athena to email portal-activation links we don't
 * want sent.
 */
const PORTAL_PATIENT_DEFAULTS: Record<string, string> = {
  language6392code: "eng",
  race: "declined",
  ethnicitycode: "declined",
  maritalstatus: "U",
  consenttocall: "true",
  consenttotext: "true",
  portalaccessgiven: "false",
  contactpreference_announcement_email: "true",
  contactpreference_announcement_phone: "true",
  contactpreference_announcement_sms: "true",
  contactpreference_appointment_email: "true",
  contactpreference_appointment_phone: "true",
  contactpreference_appointment_sms: "true",
  contactpreference_billing_email: "true",
  contactpreference_billing_phone: "true",
  contactpreference_billing_sms: "true",
  contactpreference_lab_email: "true",
  contactpreference_lab_phone: "true",
  contactpreference_lab_sms: "true",
};

// ─── Insurance Types ─────────────────────────────────────────────────────────

/** Insurance row attached to a patient chart. */
export interface AthenaInsurance {
  insuranceid: string;
  insurancepackageid: number;
  insuranceplanname: string;
  insurancetype: string;
  sequencenumber: number;
  eligibilitystatus?: string;
  [key: string]: unknown;
}

/** Payload for POST /patients/{id}/insurances. */
export interface AddInsuranceParams {
  patientId: string;
  insurancepackageid: number;
  sequencenumber?: number;
  /**
   * Athena *requires* departmentid on POST /patients/{id}/insurances
   * (matches the midi/CCDA flow in prefect patient_ops.to_insurance_payload).
   * Omitting it reliably returns 400 "departmentid is required".
   */
  departmentid: number;
  insuranceidnumber?: string;
  policynumber?: string;
  insurancepolicyholderfirstname?: string;
  insurancepolicyholderlastname?: string;
  insurancepolicyholderdob?: string;
  insurancepolicyholdersex?: string;
  relationshiptoinsuredid?: number;
}

/** Eligibility/benefit check response for a patient insurance. */
export interface EligibilityResult {
  eligibilitystatus?: string;
  eligibilitymessage?: string;
  [key: string]: unknown;
}

// ─── Appointment Types ───────────────────────────────────────────────────────

/** Appointment row from Athena scheduling endpoints. */
export interface AthenaAppointment {
  appointmentid: string;
  appointmentstatus: string;
  appointmenttype: string;
  appointmenttypeid: string;
  date: string;
  starttime: string;
  duration: number;
  departmentid: string;
  providerid: string;
  providerfirstname?: string;
  providerlastname?: string;
  patientid?: string;
  [key: string]: unknown;
}

/** Payload for PUT /appointments/{id} (book an open slot). */
export interface BookAppointmentParams {
  appointmentId: number;
  patientId: number;
  appointmenttypeid?: number;
  reasonid?: number;
  departmentid?: number;
  bookingnote?: string;
}

// ─── Reference / practice ───────────────────────────────────────────────────

/** Practice department (clinic) reference row. */
export interface AthenaDepartment {
  departmentid: string;
  name?: string;
  [key: string]: unknown;
}

/** List departments for the configured practice (for picking a valid departmentid). */
export async function getDepartments(): Promise<AthenaDepartment[]> {
  const result = await athenaRequest<
    { departments?: AthenaDepartment[] } | AthenaDepartment[]
  >("GET", "/departments", {});

  if (Array.isArray(result)) return result;
  return result.departments ?? [];
}

/** Provider directory row from GET /providers. */
export interface AthenaProvider {
  providerid: number;
  firstname?: string;
  lastname?: string;
  displayname?: string;
  providertype?: string;
  specialty?: string;
  schedulingname?: string;
  ansinamecode?: string;
  npi?: number;
  billable?: boolean;
  [key: string]: unknown;
}

/**
 * Page through Athena `/providers` until all results are collected.
 */
async function fetchAllProvidersPaginated(): Promise<AthenaProvider[]> {
  const limit = 100;
  const maxIterations = 10;

  async function fetchPage(
    offset: number,
    iteration: number,
    acc: AthenaProvider[],
  ): Promise<AthenaProvider[]> {
    if (iteration >= maxIterations) return acc;
    const result = await athenaRequest<
      | {
          providers?: AthenaProvider[];
          next?: string;
          totalcount?: number;
        }
      | AthenaProvider[]
    >("GET", "/providers", {
      params: { limit, offset },
    });
    const page = Array.isArray(result) ? result : (result.providers ?? []);
    const merged = acc.concat(page);
    if (page.length < limit) return merged;
    return fetchPage(offset + page.length, iteration + 1, merged);
  }

  return fetchPage(0, 0, []);
}

/**
 * List providers for the configured practice. Used by the registration
 * scheduler to render a ZocDoc-style provider picker.
 *
 * Athena's `/providers` returns paged results (default 25). We page through
 * up to 500 — well above the practice's ~70 active providers as of 04/2026.
 */
export async function getProviders(): Promise<AthenaProvider[]> {
  return fetchAllProvidersPaginated();
}

// ─── Patient Operations ──────────────────────────────────────────────────────

/**
 * Duplicate-aware patient lookup via GET /patients/enhancedbestmatch.
 * @param params - Demographics and optional contact filters
 */
export async function enhancedBestMatch(params: {
  firstname: string;
  lastname: string;
  dob: string;
  departmentid?: number;
  mobilephone?: string;
  email?: string;
  minscore?: number;
}): Promise<AthenaPatient[]> {
  const result = await athenaRequest<
    { patients?: AthenaPatient[] } | AthenaPatient[]
  >("GET", "/patients/enhancedbestmatch", {
    params: {
      firstname: params.firstname,
      lastname: params.lastname,
      dob: params.dob,
      departmentid: params.departmentid,
      mobilephone: params.mobilephone,
      email: params.email,
      minscore: params.minscore ?? 23,
      returnbestmatches: true,
    },
  });

  if (Array.isArray(result)) return result;
  return result.patients ?? [];
}

/** Trim to len, return undefined for empty so Athena doesn't see "". */
function clip(s: string | undefined | null, len: number): string | undefined {
  if (s === null || s === undefined) return undefined;
  const trimmed = String(s).trim();
  return trimmed ? trimmed.slice(0, len) : undefined;
}

/**
 * Athena's older signature endpoints expect `MM/DD/YYYY HH:MM:SS`
 * (24-hour, US locale) — ISO-8601 returns 400 "invalid date/time
 * format". This formatter is used by the privacy + interface
 * consent endpoints.
 */
function formatAthenaDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const yyyy = d.getFullYear();
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${mm}/${dd}/${yyyy} ${hh}:${mi}:${ss}`;
}

/** Strip non-digits, pass through to Athena which accepts 10-digit strings. */
function cleanPhone(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const digits = String(s).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : undefined;
}

/** Build the portal patient create payload with MIDI-aligned defaults and field clips. */
function buildPortalPatientCreatePayload(
  params: CreatePatientParams
): Record<string, string | number | boolean | undefined> {
  const cleanedMobile = cleanPhone(params.mobilephone);
  const cleanedHome = cleanPhone(params.homephone) ?? cleanedMobile;
  return {
    ...PORTAL_PATIENT_DEFAULTS,
    firstname: clip(params.firstname, 20),
    lastname: clip(params.lastname, 20),
    dob: params.dob,
    departmentid: params.departmentid,
    primarydepartmentid: params.primarydepartmentid ?? params.departmentid,
    sex: params.sex,
    email: params.email?.trim() || "declined",
    mobilephone: cleanedMobile,
    homephone: cleanedHome,
    address1: clip(params.address1, 60),
    address2: clip(params.address2, 60),
    city: clip(params.city, 30),
    state: clip(params.state, 2),
    zip: clip(params.zip, 10),
    ssn: params.ssn,
    maritalstatus: params.maritalstatus ?? PORTAL_PATIENT_DEFAULTS.maritalstatus,
    race: params.race ?? PORTAL_PATIENT_DEFAULTS.race,
    ethnicitycode:
      params.ethnicitycode ?? PORTAL_PATIENT_DEFAULTS.ethnicitycode,
    language6392code:
      params.language6392code ?? PORTAL_PATIENT_DEFAULTS.language6392code,
    consenttocall:
      params.consenttocall ?? PORTAL_PATIENT_DEFAULTS.consenttocall,
    consenttotext:
      params.consenttotext ?? PORTAL_PATIENT_DEFAULTS.consenttotext,
    portalaccessgiven:
      params.portalaccessgiven ?? PORTAL_PATIENT_DEFAULTS.portalaccessgiven,
    notes: `Created via patient portal self-registration on ${new Date().toLocaleDateString("en-US")}`,
  };
}

/** Create a portal patient with MIDI-aligned demographic defaults. */
export async function createPatient(
  params: CreatePatientParams
): Promise<{ patientid: string }> {
  const data = buildPortalPatientCreatePayload(params);

  const result = await athenaRequest<
    { patientid?: string; errormessage?: string }[] | { patientid: string }
  >("POST", "/patients", { data });

  if (Array.isArray(result)) {
    const first = result[0];
    if (first?.errormessage) throw new Error(first.errormessage);
    return { patientid: first?.patientid ?? "" };
  }

  return result;
}

/** Fetch a single patient chart by Athena patient id. */
export async function getPatient(
  patientId: string
): Promise<AthenaPatient> {
  const result = await athenaRequest<AthenaPatient[] | AthenaPatient>(
    "GET",
    `/patients/${patientId}`
  );
  if (Array.isArray(result)) return result[0];
  return result;
}

/**
 * Set the patient's Usual Provider (a.k.a. Primary Care Provider) and/or
 * Primary Department on the Athena chart. Athena exposes these as
 * `primaryproviderid` and `primarydepartmentid` on PUT /patients/{id}.
 * Some Athena docs and the legacy MIDI flow call the provider field
 * `usualproviderid`; both names map to the same chart attribute.
 *
 * Why both fields share one setter:
 *   In the no-account portal flow the patient can change their clinic in
 *   the schedule step (different from the demographics-step
 *   `departmentid` we use for the initial createPatient). The Usual
 *   Provider and the Primary Department both need to follow the
 *   appointment they actually booked — otherwise reminders, panel
 *   attribution (HEDIS/VBC), and the "Home / PCP" pill on the patient
 *   banner all point at the wrong clinic. A single PUT covers both.
 *
 * We deliberately call this AFTER a successful registration booking
 * (rather than on createPatient) because the patient picks their
 * provider and final clinic in the schedule step — at create time
 * neither is known authoritatively.
 *
 * Endpoint: PUT /v1/{practiceid}/patients/{patientid}
 * Reference: prefect/athena-api-documentation/api-reference/patients/update-patient.md
 */
export async function setPatientPrimaryAssignment(
  patientId: string | number,
  args: {
    providerId?: string | number | null;
    departmentId?: string | number | null;
  },
): Promise<{ success: boolean; errormessage?: string; fields: string[] }> {
  const data: Record<string, string> = {};
  const fields: string[] = [];
  if (args.providerId !== undefined && args.providerId !== null && String(args.providerId).length > 0) {
    data.primaryproviderid = String(args.providerId);
    fields.push("primaryproviderid");
  }
  if (args.departmentId !== undefined && args.departmentId !== null && String(args.departmentId).length > 0) {
    data.primarydepartmentid = String(args.departmentId);
    fields.push("primarydepartmentid");
  }
  if (fields.length === 0) {
    return { success: true, fields: [] };
  }
  const result = await athenaRequest<
    Array<{ success?: boolean; errormessage?: string }> | { success?: boolean; errormessage?: string }
  >("PUT", `/patients/${patientId}`, { data });
  const first = Array.isArray(result) ? result[0] : result;
  return {
    success: first?.success !== false && !first?.errormessage,
    errormessage: first?.errormessage,
    fields,
  };
}

/**
 * Back-compat alias: pre-2026-05-12 callers only set primaryproviderid.
 * New code should use `setPatientPrimaryAssignment` directly.
 */
export async function setPatientPrimaryProvider(
  patientId: string | number,
  providerId: string | number,
): Promise<{ success: boolean; errormessage?: string }> {
  const r = await setPatientPrimaryAssignment(patientId, { providerId });
  return { success: r.success, errormessage: r.errormessage };
}

// ─── Consent / Privacy ───────────────────────────────────────────────────────

/** Response from POST /patients/{id}/privacyinformationverified. */
export interface PrivacyVerificationResult {
  success?: boolean;
  errormessage?: string;
  [key: string]: unknown;
}

/**
 * Acknowledge the three Athena privacy/billing checkboxes for a
 * newly-created portal patient. Drives the same per-patient state
 * that staff see in athenaOne's "Privacy Information" panel:
 *
 *   - PRIVACYNOTICE     — HIPAA Notice of Privacy Practices acknowledged
 *   - PATIENTSIGNATURE  — Release of Billing Information consented
 *   - INSUREDSIGNATURE  — Assignment of Benefits signed
 *
 * The wizard collects all three implicitly: the patient agreed to our
 * Terms / Notice of Privacy Practices when they started registration,
 * so we acknowledge all three at creation time. The endpoint is
 * idempotent — calling it again with the same flags is a no-op.
 *
 * Endpoint: POST /v1/{practiceid}/patients/{patientid}/privacyinformationverified
 * Reference: prefect/athena-api-documentation/api-reference/workflows/privacy-information-verification-checkboxes.md
 */
export async function setPrivacyInformationVerified(
  patientId: string | number,
  args: {
    /** Who is signing. Pass the patient's full name as it appeared on the form. */
    signatureName: string;
    /** Department the patient is registering into (Athena uses this to scope the notice). */
    departmentId: number;
    /** Optional `MM/DD/YYYY HH:MM:SS` timestamp; defaults to now. */
    signatureDateTime?: string;
    privacyNotice?: boolean;
    patientSignature?: boolean;
    insuredSignature?: boolean;
  },
): Promise<PrivacyVerificationResult> {
  // Athena requires UPPERCASE flag names alongside the lowercase
  // metadata fields (signaturename, signaturedatetime, departmentid).
  // Validator response confirmed this in Preview on 05/11/26.
  const data: Record<string, string | number> = {
    PRIVACYNOTICE: String(args.privacyNotice ?? true),
    PATIENTSIGNATURE: String(args.patientSignature ?? true),
    INSUREDSIGNATURE: String(args.insuredSignature ?? true),
    signaturename: args.signatureName,
    signaturedatetime: args.signatureDateTime ?? formatAthenaDateTime(new Date()),
    departmentid: args.departmentId,
  };
  return athenaRequest<PrivacyVerificationResult>(
    "POST",
    `/patients/${patientId}/privacyinformationverified`,
    { data },
  );
}

/** Care Quality / HIE interface consent row for a patient. */
export interface AthenaInterfaceConsentRow {
  interfacevendorid?: string;
  consentsetting?: string;
  consentvalue?: string;
  consentby?: string;
  consentdate?: string;
  consentquestion?: string;
  isconsenting?: string;
  [key: string]: unknown;
}

/**
 * Fetch the current Care Quality / HIE interface consents for a
 * patient. Returns one row per (vendor, setting) tuple.
 *
 * Endpoint: GET /v1/{practiceid}/patients/{patientid}/interfaceconsents
 */
export async function getInterfaceConsents(
  patientId: string | number,
  departmentid: number,
): Promise<AthenaInterfaceConsentRow[]> {
  const result = await athenaRequest<
    | { interfaceconsents?: AthenaInterfaceConsentRow[] }
    | AthenaInterfaceConsentRow[]
  >("GET", `/patients/${patientId}/interfaceconsents`, {
    params: { departmentid, limit: 100 },
  });
  if (Array.isArray(result)) return result;
  return result.interfaceconsents ?? [];
}

/**
 * Grant Care Quality / HIE consent for every interface vendor the
 * practice has configured. This is the "share my chart with the rest
 * of the network so my next provider sees my history" consent —
 * patients agreed to this implicitly by accepting our HIPAA Notice
 * at registration.
 *
 * Strategy: GET the current consent list (one row per vendor/setting
 * pair) and PUT "Y" for any row that's not already consented. We
 * don't try to enumerate vendors ourselves — Athena tells us which
 * ones are active for this practice.
 *
 * Returns the number of (vendor, setting) consents written. 0 means
 * either the practice has no HIE vendors configured (common in
 * Preview) or every vendor was already consented to. Errors during
 * the PUT bubble up — callers wrap in best-effort try/catch.
 *
 * Endpoint: PUT /v1/{practiceid}/patients/{patientid}/interfaceconsents
 * Reference: prefect/athena-api-documentation/api-reference/api-reference/interface-consent.md
 */
export async function setAllInterfaceConsentsYes(
  patientId: string | number,
  departmentid: number,
): Promise<{ written: number; vendors: string[] }> {
  const current = await getInterfaceConsents(patientId, departmentid);
  if (current.length === 0) {
    return { written: 0, vendors: [] };
  }

  // Build one consent entry per row that isn't already "Y". Today's
  // date in YYYY-MM-DD per Athena conventions.
  const today = new Date().toISOString().slice(0, 10);
  const consents = current
    .filter((row) => row.consentvalue !== "Y")
    .map((row) => ({
      interfacevendorid: row.interfacevendorid,
      consentsetting: row.consentsetting,
      consentvalue: "Y",
      consentby: "PATIENT",
      consentdate: today,
    }));

  if (consents.length === 0) {
    return { written: 0, vendors: [] };
  }

  await athenaRequest("PUT", `/patients/${patientId}/interfaceconsents`, {
    data: { consents: JSON.stringify(consents) },
  });

  const vendors = Array.from(
    new Set(
      consents
        .map((c) => c.interfacevendorid)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  return { written: consents.length, vendors };
}

// ─── Insurance Operations ────────────────────────────────────────────────────

/** Attach an insurance package to a patient chart. */
export async function addInsurance(
  params: AddInsuranceParams
): Promise<AthenaInsurance> {
  const data: Record<string, string | number | boolean | undefined> = {
    insurancepackageid: params.insurancepackageid,
    sequencenumber: params.sequencenumber ?? 1,
    departmentid: params.departmentid,
    insuranceidnumber: params.insuranceidnumber,
    policynumber: params.policynumber,
    insurancepolicyholderfirstname: params.insurancepolicyholderfirstname,
    insurancepolicyholderlastname: params.insurancepolicyholderlastname,
    insurancepolicyholderdob: params.insurancepolicyholderdob,
    insurancepolicyholdersex: params.insurancepolicyholdersex,
    relationshiptoinsuredid: params.relationshiptoinsuredid,
  };

  return athenaRequest<AthenaInsurance>(
    "POST",
    `/patients/${params.patientId}/insurances`,
    { data }
  );
}

/** List insurances on a patient chart. */
export async function getPatientInsurances(
  patientId: string
): Promise<AthenaInsurance[]> {
  const result = await athenaRequest<
    { insurances?: AthenaInsurance[] } | AthenaInsurance[]
  >("GET", `/patients/${patientId}/insurances`, {
    params: { showfullssn: false },
  });

  if (Array.isArray(result)) return result;
  return result.insurances ?? [];
}

/** Run an eligibility/benefit check for a patient insurance row. */
export async function triggerEligibilityCheck(
  patientId: string,
  insuranceId: number,
  dateOfService?: string
): Promise<EligibilityResult> {
  const data: Record<string, string | number | boolean | undefined> = {};
  if (dateOfService) data.dateofservice = dateOfService;

  return athenaRequest<EligibilityResult>(
    "POST",
    `/patients/${patientId}/insurances/${insuranceId}/benefitdetails`,
    { data: Object.keys(data).length > 0 ? data : undefined }
  );
}

// ─── Appointment Operations ──────────────────────────────────────────────────

/** List appointments for a patient within an optional date window. */
export async function getPatientAppointments(
  patientId: string,
  options?: {
    startdate?: string;
    enddate?: string;
    showpast?: boolean;
  }
): Promise<AthenaAppointment[]> {
  const result = await athenaRequest<
    { appointments?: AthenaAppointment[] } | AthenaAppointment[]
  >("GET", `/patients/${patientId}/appointments`, {
    params: {
      startdate: options?.startdate,
      enddate: options?.enddate,
      showpast: options?.showpast,
    },
  });

  if (Array.isArray(result)) return result;
  return result.appointments ?? [];
}

/** List open appointment slots for a department/provider/type. */
export async function getOpenAppointments(params: {
  departmentid: number;
  providerid?: number;
  /**
   * A single Athena `appointmenttypeid`. Comma-separated lists are NOT
   * supported — Athena returns HTTP 400 ("Expecting type integer").
   * Athena auto-expands a single dedicated typeid into ALL matching
   * multi-purpose ("Any X") slots whose duration matches and whose
   * templates allow that type, so one call is enough.
   */
  appointmenttypeid?: number;
  startdate?: string;
  enddate?: string;
  /** Match Prefect athena_preview_client.get_open_slots (default true). */
  bypassScheduleTimeChecks?: boolean;
  /** Match Prefect athena_preview_client.get_open_slots (default true). */
  ignoreSchedulablePermission?: boolean;
}): Promise<AthenaAppointment[]> {
  const bypass =
    params.bypassScheduleTimeChecks !== false ? ("true" as const) : undefined;
  const ignorePerm =
    params.ignoreSchedulablePermission !== false ? ("true" as const) : undefined;

  const result = await athenaRequest<
    { appointments?: AthenaAppointment[] } | AthenaAppointment[]
  >("GET", "/appointments/open", {
    params: {
      departmentid: params.departmentid,
      providerid: params.providerid,
      appointmenttypeid: params.appointmenttypeid,
      startdate: params.startdate,
      enddate: params.enddate,
      bypassscheduletimechecks: bypass,
      ignoreschedulablepermission: ignorePerm,
    },
  });

  if (Array.isArray(result)) return result;
  return result.appointments ?? [];
}

/** Book an open slot for a patient (PUT /appointments/{id}). */
export async function bookAppointment(
  params: BookAppointmentParams
): Promise<AthenaAppointment> {
  const data: Record<string, string | number | boolean | undefined> = {
    patientid: params.patientId,
    appointmenttypeid: params.appointmenttypeid,
    reasonid: params.reasonid,
    departmentid: params.departmentid,
    bookingnote: params.bookingnote,
    nopatientcase: false,
    ignoreschedulablepermission: true,
  };

  const result = await athenaRequest<AthenaAppointment[] | AthenaAppointment>(
    "PUT",
    `/appointments/${params.appointmentId}`,
    { data }
  );

  if (Array.isArray(result)) return result[0];
  return result;
}

/** Cancel a booked appointment for a patient. */
export async function cancelAppointment(
  appointmentId: string,
  patientId: string,
  cancellationReason?: string
): Promise<void> {
  await athenaRequest("PUT", `/appointments/${appointmentId}/cancel`, {
    data: {
      patientid: patientId,
      cancellationreason: cancellationReason,
    },
  });
}

/** Move a patient from one appointment id to another open slot. */
export async function rescheduleAppointment(
  oldAppointmentId: string,
  newAppointmentId: number,
  patientId: number,
  options?: {
    reasonid?: number;
    reschedulereason?: string;
  }
): Promise<AthenaAppointment> {
  return athenaRequest<AthenaAppointment>(
    "PUT",
    `/appointments/${oldAppointmentId}/reschedule`,
    {
      data: {
        patientid: patientId,
        newappointmentid: newAppointmentId,
        ignoreschedulablepermission: true,
        reasonid: options?.reasonid,
        reschedulereason:
          options?.reschedulereason || "Rescheduled via patient portal",
      },
    }
  );
}

// ─── Insurance Package Operations ─────────────────────────────────────────

/** Insurance package row from GET /insurancepackages search. */
export interface AthenaInsurancePackage {
  insurancepackageid: number;
  insuranceplanname: string;
  addresslist?: Array<{
    address1?: string;
    city?: string;
    state?: string;
    zip?: string;
  }>;
  [key: string]: unknown;
}

/** Search Athena insurance packages by plan name (and optional member id). */
export async function searchInsurancePackages(
  insuranceplanname: string,
  memberid?: string
): Promise<AthenaInsurancePackage[]> {
  const result = await athenaRequest<
    { insurancepackages?: AthenaInsurancePackage[]; totalcount?: number } | AthenaInsurancePackage[]
  >("GET", "/insurancepackages", {
    params: {
      insuranceplanname,
      memberid: memberid || undefined,
      limit: 25,
    },
  });

  if (Array.isArray(result)) return result;
  return result.insurancepackages ?? [];
}

/**
 * Fetch a single Athena insurance package by id. Returns null on miss
 * or any failure. Used by the eligibility step to resolve the human-
 * readable plan name for the Salesforce Lead/Account when the patient's
 * attached insurances haven't propagated yet.
 */
export async function getInsurancePackageById(
  insurancepackageid: number
): Promise<AthenaInsurancePackage | null> {
  try {
    const result = await athenaRequest<
      { insurancepackages?: AthenaInsurancePackage[] } | AthenaInsurancePackage[]
    >("GET", "/insurancepackages", {
      params: { insurancepackageid, limit: 1 },
    });
    const rows = Array.isArray(result)
      ? result
      : result.insurancepackages ?? [];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
