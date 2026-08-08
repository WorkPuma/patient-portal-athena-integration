/** In-person vs telehealth visit delivery mode. */
export type VisitModality = "in_person" | "telehealth";

/** Portal scheduling category mapped to Athena appointment types. */
export type PortalCategory =
  | "routine"
  | "urgent"
  | "awv"
  | "bh_intake"
  | "bh_followup"
  | "mammo"
  | "dexa"
  | "dexa_body_comp"
  | "mammo_dexa";

/** High-level visit reason shown in the scheduling wizard. */
export type VisitReason =
  | "routine"
  | "urgent"
  | "awv"
  | "behavioral_health"
  | "member_services";

/** Portal category/modality mapping to an Athena appointment type id. */
export interface AppointmentTypeMapping {
  appointmentTypeId: number;
  name: string;
  displayName: string;
  category: PortalCategory;
  isTelehealth: boolean;
  duration: number;
}

/**
 * Client-side appointment type mapping derived from Supabase portal_appointment_type_map.
 * Hard-coded here for fast client rendering; kept in sync via the migration seed.
 */
const ALL_TYPES: AppointmentTypeMapping[] = [
  { appointmentTypeId: 49, name: "Routine Visit", displayName: "Routine Visit", category: "routine", isTelehealth: false, duration: 40 },
  { appointmentTypeId: 43, name: "Telehealth Routine Visit", displayName: "Routine Visit (Telehealth)", category: "routine", isTelehealth: true, duration: 40 },
  { appointmentTypeId: 50, name: "Urgent Visit", displayName: "Urgent Visit", category: "urgent", isTelehealth: false, duration: 40 },
  { appointmentTypeId: 44, name: "Telehealth Urgent Visit", displayName: "Urgent Visit (Telehealth)", category: "urgent", isTelehealth: true, duration: 40 },
  { appointmentTypeId: 48, name: "Annual Wellness Visit", displayName: "Annual Wellness Visit", category: "awv", isTelehealth: false, duration: 60 },
  { appointmentTypeId: 42, name: "Telehealth AWV", displayName: "Annual Wellness Visit (Telehealth)", category: "awv", isTelehealth: true, duration: 60 },
  { appointmentTypeId: 381, name: "BH Intake", displayName: "Behavioral Health Initial Visit", category: "bh_intake", isTelehealth: false, duration: 60 },
  { appointmentTypeId: 387, name: "Telehealth BH Intake", displayName: "Behavioral Health Initial (Telehealth)", category: "bh_intake", isTelehealth: true, duration: 60 },
  { appointmentTypeId: 401, name: "BH Follow-Up", displayName: "Psychotherapy Follow-Up", category: "bh_followup", isTelehealth: false, duration: 60 },
  { appointmentTypeId: 421, name: "Telehealth BH Follow-Up", displayName: "Psychotherapy Follow-Up (Telehealth)", category: "bh_followup", isTelehealth: true, duration: 60 },
  { appointmentTypeId: 482, name: "Mammo Only", displayName: "Mammogram", category: "mammo", isTelehealth: false, duration: 30 },
  { appointmentTypeId: 502, name: "DEXA Only", displayName: "DEXA Bone Density Scan", category: "dexa", isTelehealth: false, duration: 30 },
  { appointmentTypeId: 503, name: "MBR DEXA + Body Comp", displayName: "DEXA + Body Composition Scan", category: "dexa_body_comp", isTelehealth: false, duration: 30 },
  { appointmentTypeId: 504, name: "Mammo & DEXA", displayName: "Mammogram + DEXA Combo", category: "mammo_dexa", isTelehealth: false, duration: 60 },
];

/** Resolve appointment type mapping by category and modality. */
export function getAppointmentType(
  category: PortalCategory,
  modality: VisitModality
): AppointmentTypeMapping | undefined {
  return ALL_TYPES.find(
    (t) =>
      t.category === category &&
      (modality === "telehealth" ? t.isTelehealth : !t.isTelehealth)
  );
}

/** Resolve a portal appointment type mapping by Athena type id. */
export function getAppointmentTypeById(
  id: number
): AppointmentTypeMapping | undefined {
  return ALL_TYPES.find((t) => t.appointmentTypeId === id);
}

/** Returns categories valid for a given modality (member services are always in-person). */
export function getAvailableCategories(
  modality: VisitModality
): PortalCategory[] {
  const set = new Set<PortalCategory>();
  for (const t of ALL_TYPES) {
    if (modality === "telehealth" ? t.isTelehealth : !t.isTelehealth) {
      set.add(t.category);
    }
  }
  return Array.from(set);
}

/** Categories for member-services imaging visits. */
export const MEMBER_SERVICE_CATEGORIES: PortalCategory[] = [
  "mammo",
  "dexa",
  "dexa_body_comp",
  "mammo_dexa",
];

/** Behavioral-health intake and follow-up categories. */
export const BH_CATEGORIES: PortalCategory[] = ["bh_intake", "bh_followup"];

// ---------------------------------------------------------------------------
// Open-slot fetch model.
//
// Empirical behavior of Athena `GET /v1/{practice}/appointments/open`
// (verified end-to-end via scripts/probe-athena-open-slots.ts and
// scripts/probe-athena-book-flow.ts on 04/2026):
//
//   * `appointmenttypeid` MUST be a single integer. Comma-separated lists
//     return HTTP 400 ("Expecting type integer, but value is …").
//   * Athena auto-expands a single dedicated typeid into ALL matching
//     multi-purpose ("Any X") slots whose duration matches and whose
//     templates allow that type. e.g., querying typeid=49 (Routine 40m)
//     returns dedicated 49 slots PLUS every "Any 40 (Routine, Urgent)"
//     slot. Important: the Initial Visit is the exception — only the
//     "Any 90 (Initial)" pool (typeid 142) is templated as bookable, so
//     querying with the older dedicated typeid 461 returns *60-min* Any
//     20 / Any 60 expansions which are NOT valid Initial Visit slots.
//   * On `PUT /appointments/{appointmentid}` Athena rewrites the slot to
//     the supplied `appointmenttypeid`, regardless of the slot's original
//     type. So we book the slot's `appointmentid` with the SAME typeid we
//     queried with, never with `slot.appointmenttypeid`.
//
// In short: pick the right *intent* (one dedicated typeid per visit kind)
// and Athena does the slot-pool merging for us. No fan-out, no
// post-processing, no comma lists.
// ---------------------------------------------------------------------------

/**
 * Generic ("Any X") slot type IDs. Captured from
 * `athena.athenaone.appointmenttype` where `GENERICYN='Y'`. Kept here as
 * documentation only — the UI never queries these directly because
 * Athena's expansion (described above) already pulls them in when we ask
 * for a dedicated type of matching duration.
 */
export const GENERIC_SLOT_POOLS: ReadonlyArray<{
  typeId: number;
  duration: number;
  modality: VisitModality;
  label: string;
}> = [
    { typeId: 21, duration: 10, modality: "in_person", label: "Any 10" },
    { typeId: 521, duration: 15, modality: "in_person", label: "Any 15" },
    { typeId: 66, duration: 20, modality: "in_person", label: "Any 20" },
    { typeId: 501, duration: 30, modality: "in_person", label: "Any 30" },
    { typeId: 64, duration: 40, modality: "in_person", label: "Any 40 (Routine, Urgent)" },
    { typeId: 65, duration: 60, modality: "in_person", label: "Any 60 (AWV, PreOp, TOC)" },
    { typeId: 142, duration: 90, modality: "in_person", label: "Any 90 (Initial)" },
    { typeId: 221, duration: 40, modality: "telehealth", label: "Telehlth Any 40 (Rtn, Urg)" },
    { typeId: 222, duration: 60, modality: "telehealth", label: "Telehlth Any 60 (AWV, TOC)" },
    { typeId: 223, duration: 90, modality: "telehealth", label: "Telehlth Any 90 (Initial)" },
  ];

/**
 * Canonical Initial Visit appointment type per modality. The
 * established-patient `SchedulingWizard` falls back to this map for the
 * `!isEstablished` (one-completed-visit) edge case. The dedicated new-
 * patient registration flow does NOT use this — it uses
 * {@link getRegistrationInitialVisitTypeId} below, which adds the
 * commercial-vs-Medicare branch.
 *
 *   - in_person  → 142 ("Any 90 (Initial)"). In Prod Athena's templates
 *                  mark this 90-minute generic pool as bookable across
 *                  all primary-care clinics. Earlier code used 461
 *                  ("MBR - Initial Visit", 60m) but that returned 60-min
 *                  Any 20 / Any 60 slots — the wrong duration for a
 *                  *non-MBR* Initial Visit. Verified via
 *                  probe-schedule-redesign.ts (04/2026): typeid=142
 *                  returns genuine 90-min slots; booking with typeid=142
 *                  succeeds and Athena replies with
 *                  duration=90 / "Any 90 (Initial)".
 *   - telehealth → 223 (Telehlth Any 90 Initial). No dedicated telehealth
 *                  Initial Visit type exists — the Any-90 pool IS the
 *                  bookable. Athena's response after PUT shows
 *                  appointmenttypeid=223.
 */
const INITIAL_VISIT_TYPE_ID: Record<VisitModality, number> = {
  in_person: 142,
  telehealth: 223,
};

/**
 * Single Athena `appointmenttypeid` to use for an Initial Visit fetch+book
 * from the **established-patient** `SchedulingWizard` only. Do NOT call
 * this from the new-patient registration flow — registration must use
 * {@link getRegistrationInitialVisitTypeId} so commercial / membership
 * patients route to the dedicated MBR Initial Visit type (461) and
 * Medicare / non-commercial patients route to the dedicated Initial
 * Visit type (47).
 */
export function getInitialVisitTypeId(modality: VisitModality): number {
  return INITIAL_VISIT_TYPE_ID[modality];
}

// ---------------------------------------------------------------------------
// Registration-flow Initial Visit selection
//
// The new-patient registration wizard (`InitialVisitScheduler`) is a
// different concern from the established-patient `SchedulingWizard`:
//
//   - SchedulingWizard is for established patients. It picks Routine /
//     Urgent / AWV / etc. dedicated typeids (49/50/48/...) and never
//     queries the Initial Visit pool — except for an unusual one-visit
//     edge case which falls back to the legacy `getInitialVisitTypeId`
//     map above. We intentionally do NOT change that path.
//
//   - InitialVisitScheduler is for brand-new patients. The visit kind
//     branches on insurance:
//
//       * MBR (commercial / membership-eligible) → typeid 461
//         ("MBR - Initial Visit", 60-minute dedicated). This is the
//         visit Herself Health bills as a membership intake.
//
//       * Standard (Medicare / Medicaid / TRICARE / VA — i.e. anything
//         flagged `isGovernmentFunded`) → typeid 47 ("Initial Visit",
//         90-minute dedicated). The 90-minute slot is required for the
//         long Medicare-AWV-style new-patient intake.
//
//       * Telehealth (regardless of payer) → typeid 223
//         ("Telehlth Any 90 (Initial)"). Athena does not publish a
//         dedicated MBR telehealth type, so commercial telehealth
//         registrants share the standard 223 pool.
//
// Empirical Preview-tenant slot coverage as of 04/2026 (60-day horizon,
// `ignoreschedulablepermission=true`, scripts/probe-athena-initial-slot-
// coverage.ts):
//
//                       id=47 Initial   id=142 Any90   id=461 MBR Initial
//   Highland Park           159              48              530
//   Crystal                 164               0              286
//   Lyndale                 149               0              263
//   Rosedale                283               0              540
//   Eagan                   127               0              272
//
// Earlier the registration flow pinned all in-person Initial Visits to
// 142, which only resolves at Highland Park in Preview (templates at the
// other four clinics never opened the generic Any-90 pool). Switching to
// 47 / 461 surfaces slots at every clinic.
// ---------------------------------------------------------------------------

/**
 * Insurance class for the registration Initial Visit selector.
 *   - "standard": Medicare / Medicaid / TRICARE / VA → 90-min
 *                 dedicated Initial Visit (typeid 47).
 *   - "mbr":      Commercial / membership-eligible → 60-min MBR
 *                 Initial Visit (typeid 461).
 */
export type RegistrationVisitVariant = "standard" | "mbr";

const REGISTRATION_INITIAL_VISIT_TYPE_ID: Record<
  RegistrationVisitVariant,
  Record<VisitModality, number>
> = {
  // Government-funded → the dedicated 90-minute Initial Visit type.
  standard: {
    in_person: 47,
    telehealth: 223,
  },
  // Commercial / membership → the dedicated 60-minute MBR Initial Visit
  // type. Athena does not expose a telehealth equivalent, so telehealth
  // commercial registrants fall back to the same generic 90-min pool
  // standard patients use.
  mbr: {
    in_person: 461,
    telehealth: 223,
  },
};

/**
 * Athena `appointmenttypeid` for a registration-flow Initial Visit.
 * `variant` defaults to `"standard"` for backwards-compat with callers
 * that haven't yet been threaded through the insurance classifier.
 */
export function getRegistrationInitialVisitTypeId(
  modality: VisitModality,
  variant: RegistrationVisitVariant = "standard"
): number {
  return REGISTRATION_INITIAL_VISIT_TYPE_ID[variant][modality];
}

/**
 * Allowlist of `appointmenttypeid` values that the registration API
 * routes (`/api/portal/register/appointments/{available,book}`) accept
 * from the client. Anything outside this set is rejected — a regToken
 * is scoped to the new-patient Initial Visit, never to the established-
 * patient appointment pool.
 */
export const REGISTRATION_INITIAL_VISIT_TYPE_IDS: ReadonlySet<number> =
  new Set<number>([
    REGISTRATION_INITIAL_VISIT_TYPE_ID.standard.in_person, // 47
    REGISTRATION_INITIAL_VISIT_TYPE_ID.standard.telehealth, // 223
    REGISTRATION_INITIAL_VISIT_TYPE_ID.mbr.in_person, // 461
    REGISTRATION_INITIAL_VISIT_TYPE_ID.mbr.telehealth, // 223
    // Legacy: keep `Any 90 (Initial)` (142) accepted for now so any
    // wizard tab loaded against an older client bundle (which still
    // passes 142) keeps working until clients refresh. Safe — 142 is
    // still a patient-bookable Initial Visit pool; it just covers fewer
    // clinics in Preview than 47.
    142,
  ]);

// ---------------------------------------------------------------------------
// Athena open-slot post-filter
//
// Athena's `/appointments/open` expansion (described in the comment block
// near the top of this file) returns generic-pool slots whose duration
// matches the queried type. For Initial Visit queries that pulls in pools
// we DON'T want shown to the patient:
//
//   - typeid 47  (Initial Visit, 90m)        -> can return 60-min "Any 60" expansions
//   - typeid 142 (Any 90 Initial pool, 90m)  -> 90-min only by definition (safe)
//   - typeid 223 (Telehealth Any 90, 90m)    -> 90-min only by definition (safe)
//   - typeid 461 (MBR Initial, 60m)          -> can return "Any 60", "Any 20" generics
//
// Product policy (2026-05): for commercial / membership Initial Visits we
// only ever book the dedicated MBR type (461). Patients never get assigned
// to a generic 60-min pool. For standard 90-min Initial Visits, any 90-min
// pool that Athena considers bookable (47, 142, 223) is fine.
// ---------------------------------------------------------------------------

/** Open slot row from Athena GET /appointments/open. */
export interface AthenaOpenSlot {
  appointmentid?: string | number;
  appointmenttypeid?: string | number;
  appointmenttype?: string;
  duration?: string | number;
  [k: string]: unknown;
}

/** Numeric-coerce; returns `null` if not a finite number. */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Drop slots that don't match the queried registration Initial Visit type.
 *
 *   - When `queriedTypeId` is omitted (no client filter), nothing is
 *     stripped — the regToken allowlist + downstream ID branching is the
 *     only protection.
 *   - When `queriedTypeId === 461` (commercial MBR), keep ONLY slots whose
 *     `appointmenttypeid` is also 461. Drops every Athena generic pool
 *     ("Any 60", "Any 20", etc.) regardless of duration match.
 *   - When `queriedTypeId` is a 90-min Initial Visit type (47, 142, 223),
 *     keep slots whose `duration` is 90. Drops the 60-min Any-60
 *     expansions Athena leaks into the response.
 */
export function filterRegistrationInitialVisitSlots(
  slots: AthenaOpenSlot[],
  queriedTypeId?: number
): AthenaOpenSlot[] {
  if (!queriedTypeId) return slots;

  // Commercial: dedicated MBR slot only. Generic-pool substitutes are
  // intentionally rejected per product policy.
  if (queriedTypeId === REGISTRATION_INITIAL_VISIT_TYPE_ID.mbr.in_person) {
    return slots.filter(
      (s) =>
        toNum(s.appointmenttypeid) ===
        REGISTRATION_INITIAL_VISIT_TYPE_ID.mbr.in_person
    );
  }

  // 90-min Initial Visit family (47, 142, 223): keep only 90-min slots.
  if (
    queriedTypeId === REGISTRATION_INITIAL_VISIT_TYPE_ID.standard.in_person ||
    queriedTypeId === REGISTRATION_INITIAL_VISIT_TYPE_ID.standard.telehealth ||
    queriedTypeId === 142
  ) {
    return slots.filter((s) => toNum(s.duration) === 90);
  }

  // Anything outside the registration allowlist shouldn't reach this
  // function (gated upstream), but be conservative and leave the response
  // unchanged rather than silently emptying it.
  return slots;
}

/**
 * Map the persisted registration `StoredInsurance.isGovernmentFunded`
 * flag (set by the eligibility step) to the Initial Visit variant.
 * `null`/missing insurance defaults to `"standard"` (90-min Initial
 * Visit) which is the safer fallback — any clinic can fulfill it.
 */
export function getRegistrationVariantFromInsurance(insurance: {
  isGovernmentFunded?: boolean;
} | null | undefined): RegistrationVisitVariant {
  if (!insurance) return "standard";
  // Distinguish "explicitly commercial" (false) from "unknown" (undefined).
  // Only flip to MBR when the eligibility step affirmatively flagged the
  // coverage as non-government-funded; an absent flag means we don't know
  // yet, so we use the safer 90-min Initial Visit pool.
  if (insurance.isGovernmentFunded === false) return "mbr";
  return "standard";
}

/**
 * A patient is "established" once they have completed more than one visit
 * (Athena appointmentstatus 3 = checked-out, 4 = charge entered). Only
 * established patients see the chief-complaint picker; everyone else is
 * pinned to an Initial Visit.
 */
export function isEstablishedPatient(completedVisits: number): boolean {
  return completedVisits > 1;
}

/** Athena appointment statuses that count as a completed visit. */
export const COMPLETED_APPOINTMENT_STATUSES = new Set(["3", "4"]);

/**
 * A patient-facing visit reason that maps to one or more Athena
 * `clinicalencounterreason` rows. The IDs are the structured values we
 * forward when booking so the chart picks up a normalized chief complaint.
 *
 * Source of truth: derived from `athena.athenaone.clinicalencounterreason`
 * usage counts joined to `clinicalencounterdata` (key=CLINICALENCOUNTERREASON)
 * across routine (49/43/48/42) vs urgent (50/44) appointment types.
 */
export interface ScheduleReasonOption {
  label: string;
  reasonIds: number[];
}

/** Chief-complaint options for urgent visit booking. */
export const URGENT_REASONS: ScheduleReasonOption[] = [
  { label: "Possible UTI / urinary symptoms", reasonIds: [15] },
  { label: "Cough", reasonIds: [16] },
  {
    label: "Cold, sinus, sore throat, or congestion",
    reasonIds: [61, 80, 55, 261, 73, 17],
  },
  { label: "Skin problem or rash", reasonIds: [9, 26] },
  { label: "Ear pain, infection, or ear wax", reasonIds: [50, 10, 70, 101] },
  {
    label: "Stomach — nausea, vomiting, diarrhea, or abdominal pain",
    reasonIds: [1, 11, 67, 13, 52],
  },
  { label: "Vaginal symptoms", reasonIds: [78] },
  { label: "Swelling / edema", reasonIds: [241] },
  { label: "Back pain", reasonIds: [4, 53] },
  { label: "COVID-19 symptoms", reasonIds: [86] },
  { label: "Eye irritation or pink eye", reasonIds: [102, 81] },
  { label: "Headache or migraine", reasonIds: [8, 18] },
  { label: "Fall or injury", reasonIds: [281] },
];

/** Chief-complaint options for routine visit booking. */
export const ROUTINE_REASONS: ScheduleReasonOption[] = [
  {
    label: "Annual wellness visit / physical",
    reasonIds: [74, 75, 201, 381, 60, 79, 25],
  },
  { label: "General follow-up", reasonIds: [162] },
  { label: "Lab or test results review", reasonIds: [27, 141, 288] },
  { label: "Medication refill or med check", reasonIds: [62, 283, 289] },
  { label: "Hypertension follow-up", reasonIds: [22] },
  { label: "Weight management", reasonIds: [161, 242, 243, 54] },
  { label: "INR / anticoagulation", reasonIds: [221, 421] },
  { label: "Diabetes follow-up", reasonIds: [20] },
  {
    label: "Cardiac follow-up (Heartwise for Her, palpitations)",
    reasonIds: [401, 402, 284, 286, 285],
  },
  {
    label: "Transition of care or new patient / pre-op",
    reasonIds: [181, 121, 441, 23],
  },
];

/** @deprecated Use {@link URGENT_REASONS}. Kept as a flat label list for the
 * existing symptom-checklist UI. */
export const URGENT_SYMPTOMS: readonly string[] = URGENT_REASONS.map(
  (r) => r.label
);

/** Lookup a reason option by any of its Athena reasonIds. */
export function findReasonOption(
  reasonId: number
): { bucket: "urgent" | "routine"; option: ScheduleReasonOption } | undefined {
  for (const option of URGENT_REASONS) {
    if (option.reasonIds.includes(reasonId)) {
      return { bucket: "urgent", option };
    }
  }
  for (const option of ROUTINE_REASONS) {
    if (option.reasonIds.includes(reasonId)) {
      return { bucket: "routine", option };
    }
  }
  return undefined;
}

/** Client scheduling wizard selections persisted across steps. */
export interface WizardState {
  modality: VisitModality | null;
  visitReason: VisitReason | null;
  selectedCategory: PortalCategory | null;
  appointmentTypeId: number | null;
  selectedSlotId: string | null;
  departmentId: string;
  providerId: string;
}

/** Default empty scheduling wizard state. */
export const INITIAL_WIZARD_STATE: WizardState = {
  modality: null,
  visitReason: null,
  selectedCategory: null,
  appointmentTypeId: null,
  selectedSlotId: null,
  departmentId: "",
  providerId: "",
};

/** Ordered step ids in the authenticated scheduling wizard. */
export type WizardStep = "modality" | "visit_reason" | "calendar" | "confirm";

/** Scheduling wizard step sequence. */
export const WIZARD_STEPS: WizardStep[] = [
  "modality",
  "visit_reason",
  "calendar",
  "confirm",
];

/** Zero-based index of a wizard step in WIZARD_STEPS. */
export function getStepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/** Human label for a wizard step. */
export function getStepLabel(step: WizardStep): string {
  switch (step) {
    case "modality":
      return "Visit Type";
    case "visit_reason":
      return "Reason";
    case "calendar":
      return "Select Time";
    case "confirm":
      return "Confirm";
  }
}
