/**
 * Server-only Stedi healthcare API wrapper.
 *
 * Reads STEDI_API_KEY, STEDI_PROVIDER_NPI, STEDI_PROVIDER_ORG_NAME from the
 * environment. Never imported from the client — registration UI talks to this
 * exclusively through /api/portal/register/eligibility.
 *
 * The Stedi API key is a long-lived production credential. Treat it like a
 * cardholder secret: never log it, never include it in error responses,
 * never serialize it into Sentry breadcrumbs.
 */

import "server-only";

/** Subscriber block on a Stedi real-time eligibility request. */
export interface StediEligibilitySubscriber {
  firstName: string;
  lastName: string;
  /** YYYYMMDD per X12 spec. */
  dateOfBirth: string;
  memberId: string;
  /** Optional — only attach when the patient supplied one (Athena uses "1" = Self). */
  groupNumber?: string;
}

/**
 * Provider object on the 270. Per Stedi's spec you supply either
 * `organizationName` (entity is an organization) or `firstName` + `lastName`
 * (entity is an individual). `npi` is required either way.
 *
 * Some payers — notably MN Medicaid (MHCP / DPWMN) — reject the org NPI with
 * AAA*45 ("Invalid/Missing Provider Specialty") because the org NPI is
 * enrolled for billing but not registered with a specialty for inquiry
 * traffic. Sending an individual rendering provider's NPI clears the AAA.
 */
export interface StediEligibilityProvider {
  npi: string;
  organizationName?: string;
  firstName?: string;
  lastName?: string;
}

/** Real-time eligibility (270/271) request body for Stedi. */
export interface StediEligibilityRequest {
  /** Stedi tradingPartnerServiceId (e.g. "60054" Aetna, "DPWMN" MN Medicaid). */
  tradingPartnerServiceId: string;
  subscriber: StediEligibilitySubscriber;
  /** Defaults to ["30"] (Health Plan / general benefits). */
  serviceTypeCodes?: string[];
  /**
   * Override the default org-level rendering provider (HERSELF HEALTH MN PC).
   * Set this for payers that require an individual NPI on the 270 — see
   * MN Medicaid AAA*45 above.
   */
  provider?: StediEligibilityProvider;
}

/** Stedi-style error with the HTTP status, structured body, and X12 AAA codes (when present). */
export class StediApiError extends Error {
  readonly statusCode: number;
  readonly aaaCodes: string[];
  readonly responseBody: string;

  constructor(
    message: string,
    statusCode: number,
    aaaCodes: string[],
    responseBody: string
  ) {
    super(message);
    this.name = "StediApiError";
    this.statusCode = statusCode;
    this.aaaCodes = aaaCodes;
    this.responseBody = responseBody;
  }
}

const STEDI_BASE_URL = "https://healthcare.us.stedi.com/2024-04-01";
const ELIGIBILITY_PATH =
  "/change/medicalnetwork/eligibility/v3";

/** Generic Stedi 271 response — wide on purpose. The summary normalizer narrows it. */
export interface StediEligibilityResponse {
  controlNumber?: string;
  errors?: Array<{ code: string; description?: string }>;
  payer?: {
    name?: string;
    etin?: string;
    payorIdentification?: string;
  };
  planStatus?: Array<{
    statusCode?: string;
    planDetails?: string;
    serviceTypeCodes?: string[];
  }>;
  planInformation?: {
    planName?: string;
    groupNumber?: string;
    groupDescription?: string;
  };
  planDateInformation?: {
    planBegin?: string;
    planEnd?: string;
    eligibilityBegin?: string;
    eligibilityEnd?: string;
  };
  benefitsInformation?: Array<{
    serviceTypeCodes?: string[];
    benefitAmount?: string;
    code?: string;
    /** EB04 Insurance Type Code (C1/GP/PR/PS/HM/HD/EP/MA/MB/MC/OT/etc). */
    insuranceTypeCode?: string;
  }>;
  subscriber?: {
    /** Populated by MBI Lookup responses (CMS returns the resolved MBI here). */
    memberId?: string;
    firstName?: string;
    lastName?: string;
    middleName?: string;
    gender?: string;
    dateOfBirth?: string;
    subscriberOtherPayers?: Array<{
      name?: string;
      identification?: { identificationNumber?: string };
      insuranceTypeCode?: string;
    }>;
  };
}

let controlSeed = Math.floor(Math.random() * 900000) + 100000;
function nextControlNumber(): string {
  controlSeed = (controlSeed + 1) % 999999999;
  return String(controlSeed).padStart(6, "0");
}

function getProvider(): { organizationName: string; npi: string } {
  const npi = process.env.STEDI_PROVIDER_NPI;
  const org = process.env.STEDI_PROVIDER_ORG_NAME || "HERSELF HEALTH MN PC";
  if (!npi) {
    throw new Error(
      "STEDI_PROVIDER_NPI is not set; cannot run eligibility checks."
    );
  }
  return { organizationName: org, npi };
}

/**
 * Run a 270 eligibility request against Stedi and return the parsed 271.
 * Throws StediApiError on non-2xx; returns the raw response on 2xx (callers
 * decide how to interpret AAA codes — pre-attestation gov payers return 200
 * with AAA*41 in `errors[]`, which is a *successful round-trip*).
 */
export async function runEligibilityCheck(
  request: StediEligibilityRequest,
  signal?: AbortSignal
): Promise<StediEligibilityResponse> {
  const apiKey = process.env.STEDI_API_KEY;
  if (!apiKey) {
    throw new Error("STEDI_API_KEY is not set; cannot run eligibility checks.");
  }

  const body = {
    controlNumber: nextControlNumber(),
    tradingPartnerServiceId: request.tradingPartnerServiceId,
    encounter: {
      serviceTypeCodes: request.serviceTypeCodes ?? ["30"],
    },
    provider: request.provider ?? getProvider(),
    subscriber: {
      firstName: request.subscriber.firstName,
      lastName: request.subscriber.lastName,
      dateOfBirth: request.subscriber.dateOfBirth,
      memberId: request.subscriber.memberId,
      ...(request.subscriber.groupNumber
        ? { groupNumber: request.subscriber.groupNumber }
        : {}),
    },
  };

  const res = await fetch(`${STEDI_BASE_URL}${ELIGIBILITY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: StediEligibilityResponse | null = null;
  try {
    parsed = text ? (JSON.parse(text) as StediEligibilityResponse) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const aaa = (parsed?.errors ?? []).map((e) => e.code).filter(Boolean);
    throw new StediApiError(
      `Stedi eligibility ${res.status}`,
      res.status,
      aaa,
      text.slice(0, 500)
    );
  }

  return parsed ?? {};
}

/**
 * Run a CMS MBI Lookup (Without SSN) request and return the raw 271.
 *
 * Stedi exposes two payer aliases that swap the standard 270 for a
 * "find this patient's MBI at CMS" transaction:
 *   - MBILU      → with SSN (firstName + lastName + DOB + SSN)
 *   - MBILUNOSSN → no SSN  (firstName + lastName + DOB + state)
 *
 * We only ever use the no-SSN variant — we never collect SSN at registration.
 * On success the response is a full CMS 271 with the MBI populated in
 * `subscriber.memberId`. On failure CMS returns AAA*72 (subscriber not
 * found) — that's not an HTTP error, the caller checks `response.errors`.
 *
 * Per Stedi docs MBI lookups require transaction enrollment, but probe
 * traffic 2026-05-07 succeeded without explicit enrollment for our org.
 * Treat enrollment errors as a soft-fail at the call site.
 */
export async function runMbiLookupNoSsn(
  patient: {
    firstName: string;
    lastName: string;
    /** YYYYMMDD per X12 spec. */
    dateOfBirth: string;
    /** US state two-letter code (e.g., "MN"). */
    state: string;
  },
  signal?: AbortSignal
): Promise<StediEligibilityResponse> {
  const apiKey = process.env.STEDI_API_KEY;
  if (!apiKey) {
    throw new Error("STEDI_API_KEY is not set; cannot run MBI lookup.");
  }

  const body = {
    controlNumber: nextControlNumber(),
    tradingPartnerServiceId: "MBILUNOSSN",
    encounter: { serviceTypeCodes: ["30"] },
    provider: getProvider(),
    subscriber: {
      firstName: patient.firstName,
      lastName: patient.lastName,
      dateOfBirth: patient.dateOfBirth,
      address: { state: patient.state },
    },
  };

  const res = await fetch(`${STEDI_BASE_URL}${ELIGIBILITY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: StediEligibilityResponse | null = null;
  try {
    parsed = text ? (JSON.parse(text) as StediEligibilityResponse) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const aaa = (parsed?.errors ?? []).map((e) => e.code).filter(Boolean);
    throw new StediApiError(
      `Stedi MBI lookup ${res.status}`,
      res.status,
      aaa,
      text.slice(0, 500)
    );
  }
  return parsed ?? {};
}

/** Payer search hit from the Stedi payer directory API. */
export interface StediPayerSearchResult {
  stediId: string;
  primaryPayerId: string | null;
  displayName: string | null;
  aliases: string[];
  operatingStates: string[];
}

/**
 * Search Stedi's payer catalog. Used at seed time and from the dev console;
 * NOT in the hot patient-registration path. Cached call sites should wrap
 * this with their own TTL store.
 */
export async function searchStediPayers(
  query: string,
  pageSize = 10
): Promise<StediPayerSearchResult[]> {
  const apiKey = process.env.STEDI_API_KEY;
  if (!apiKey) throw new Error("STEDI_API_KEY is not set.");

  const url = `${STEDI_BASE_URL}/payers/search?query=${encodeURIComponent(query)}&pageSize=${pageSize}`;
  const res = await fetch(url, {
    headers: { Authorization: `Key ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new StediApiError(
      `Stedi payers/search ${res.status}`,
      res.status,
      [],
      body
    );
  }

  const json = (await res.json()) as {
    items?: Array<{
      payer?: {
        stediId?: string;
        primaryPayerId?: string;
        displayName?: string;
        aliases?: string[];
        operatingStates?: string[];
      };
    }>;
  };

  return (json.items ?? []).map((it) => ({
    stediId: it.payer?.stediId ?? "",
    primaryPayerId: it.payer?.primaryPayerId ?? null,
    displayName: it.payer?.displayName ?? null,
    aliases: it.payer?.aliases ?? [],
    operatingStates: it.payer?.operatingStates ?? [],
  }));
}
