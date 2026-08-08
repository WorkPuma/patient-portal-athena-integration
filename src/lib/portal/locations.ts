/**
 * Curated clinic locations for the portal scheduling experience.
 *
 * Source of truth: Athena `/v1/{practice}/departments`. We cache the raw
 * response, then filter to the patient-facing primary care clinics so the
 * registration scheduler doesn't accidentally surface ancillary departments
 * (Behavioral Health, Vaccine Clinic, etc) as "Initial Visit" locations.
 *
 * Per Databricks/Athena (04/2026), the practice has these departments:
 *   - 2  Highland Park   (St. Paul)
 *   - 3  Crystal
 *   - 4  Lyndale         (Minneapolis)
 *   - 5  Rosedale        (Roseville)
 *   - 6  Eagan           (St. Paul)
 *   - 9  Behavioral Health (Crystal — BH-only specialists)
 *   - 10 Vaccine Clinic   (Highland Park — pop-in only)
 *
 * `INITIAL_VISIT_DEPARTMENT_IDS` enumerates the five primary care clinics
 * a brand-new patient may register against; the BH and Vaccine departments
 * are intentionally excluded.
 */

import { getDepartments } from "@/lib/athena/client";
import { cacheGet, cacheSet } from "@/lib/upstash/cache";

/** Athena department ids that accept new-patient Initial Visits. */
export const INITIAL_VISIT_DEPARTMENT_IDS: ReadonlyArray<number> = [
  2, 3, 4, 5, 6,
];

/** Storyblok location slug per Athena department id. Used to join with the
 * provider directory in Storyblok (which keys by these slugs). */
export const DEPARTMENT_SLUG_BY_ID: Readonly<Record<number, string>> = {
  2: "highland-park",
  3: "crystal",
  4: "lyndale",
  5: "rosedale",
  6: "eagan",
};

export interface PortalClinicLocation {
  departmentid: number;
  /** Storyblok-friendly slug (e.g. "highland-park"). */
  slug: string;
  /** Patient-facing name (e.g. "Herself Health Highland Park"). */
  name: string;
  shortName: string;
  /** Title-cased street line, e.g. "2000 Rahncliff Ct Ste 400". */
  address1: string;
  /** Title-cased secondary line, e.g. "Suite 145". */
  address2: string | null;
  city: string;
  state: string;
  zip: string;
  /**
   * Patient-facing one-liner, ZIP intentionally omitted:
   *   "2000 Rahncliff Ct Ste 400, Saint Paul, MN"
   * Use this in UI so all surfaces stay consistent.
   */
  formattedAddress: string;
  phone: string | null;
}

// v2: shape changed (added `formattedAddress`, title-cased street fields).
// Bump on any further field changes so stale caches don't serve missing keys.
const CACHE_KEY = "register-locations:v2";
const CACHE_TTL = 60 * 60; // 1h — Athena department list is effectively static

interface AthenaDeptRaw {
  departmentid: string | number;
  name?: string;
  patientdepartmentname?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  [key: string]: unknown;
}

function normalize(dept: AthenaDeptRaw): PortalClinicLocation | null {
  const departmentid = typeof dept.departmentid === "string"
    ? parseInt(dept.departmentid, 10)
    : dept.departmentid;
  if (!Number.isFinite(departmentid)) return null;
  const slug = DEPARTMENT_SLUG_BY_ID[departmentid];
  if (!slug) return null;

  const fullName = dept.patientdepartmentname || dept.name || "Herself Health";
  const shortName = (dept.name || fullName).replace(/^Herself Health\s+/i, "");

  const address1 = toTitleAddress(dept.address ?? "");
  const address2 = dept.address2 ? toTitleAddress(dept.address2) : null;
  const city = dept.city ? toTitleCase(dept.city) : "";
  const state = (dept.state ?? "").toUpperCase();
  const zip = dept.zip ?? "";

  // Patient-facing line: "<street>[, <suite>], <City>, ST". ZIP omitted —
  // it's noise in a clinic-picker UI and was explicitly called out in the
  // design feedback.
  const streetLine = address2 ? `${address1}, ${address2}` : address1;
  const cityState = [city, state].filter(Boolean).join(", ");
  const formattedAddress = [streetLine, cityState].filter(Boolean).join(", ");

  return {
    departmentid,
    slug,
    name: fullName,
    shortName,
    address1,
    address2,
    city,
    state,
    zip,
    formattedAddress,
    phone: dept.phone ?? null,
  };
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// US street tokens that should stay uppercase even after title-casing.
// (Athena returns addresses in ALL CAPS — "2000 RAHNCLIFF CT STE 400" — so
// we need to lowercase first, then preserve the conventional abbreviations.)
const UPPERCASE_ADDRESS_TOKENS = new Set([
  "N", "S", "E", "W",
  "NE", "NW", "SE", "SW",
  "PO", "PMB", "USA", "US",
]);

function toTitleAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .toLowerCase()
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      // Numbers, ordinals (1st, 2nd), and unit indicators (#145) keep
      // their lowercase suffix as-is — Title-Case would mangle them.
      if (/^[#\d]/.test(tok)) return tok;
      // Split off trailing punctuation (commas, periods) so directional
      // tokens like "N," / "NE." still match the uppercase set.
      const match = tok.match(/^([a-z]+)([^a-z]*)$/i);
      if (match) {
        const [, word, tail] = match;
        const upper = word.toUpperCase();
        if (UPPERCASE_ADDRESS_TOKENS.has(upper)) return upper + tail;
        return word.charAt(0).toUpperCase() + word.slice(1) + tail;
      }
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join("");
}

/**
 * Returns the primary care clinic locations available for new-patient
 * registration. Cached aggressively because Athena returns the same list
 * for hours/days at a time.
 */
export async function listActiveLocations(): Promise<PortalClinicLocation[]> {
  const cached = await cacheGet<PortalClinicLocation[]>(CACHE_KEY, {
    prefix: "portal",
  });
  if (cached) return cached;

  const raw = (await getDepartments()) as unknown as AthenaDeptRaw[];
  const normalized = raw
    .map(normalize)
    .filter((x): x is PortalClinicLocation => x !== null)
    .sort((a, b) => a.shortName.localeCompare(b.shortName));

  await cacheSet(CACHE_KEY, normalized, {
    prefix: "portal",
    ttl: CACHE_TTL,
  });
  return normalized;
}
