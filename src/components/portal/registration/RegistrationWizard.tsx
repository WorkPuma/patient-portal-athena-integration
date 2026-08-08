"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  ArrowLeft,
  Loader2,
  Lock,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { getPortalDefaultDepartmentId } from "@/lib/portal";
import {
  PORTAL_LOGO_URL,
  PORTAL_LOGO_ALT,
  PORTAL_LOGO_WIDTH,
  PORTAL_LOGO_HEIGHT,
} from "@/lib/portal-branding";
import { getClientPortalFeatureFlags } from "@/lib/portal/feature-flags";
import { cn } from "@/lib/utils";
import {
  loadRegistrationDraft,
  registerFetch,
  saveRegistration,
  saveRegistrationDraft,
} from "./registration-client";
import { AddressAutocomplete } from "./AddressAutocomplete";
import {
  getAttribution,
  resolveLeadSourceFromAttribution,
} from "@/lib/tracking/attribution";
import {
  trackRegistrationStarted,
  trackRegistrationDemographicsSubmitted,
  trackRegistrationOffRamp,
} from "@/lib/posthog/events";
import { recordRegistrationAnalyticsConsent } from "@/lib/tracking/posthog-consent";
import {
  PRIVACY_POLICY_HREF,
  SMS_CONSENT_CHECKBOX_TEXT,
  TERMS_OF_SERVICE_HREF,
} from "@/lib/legal/sms-consent";

/**
 * Registration wizard for new patients — no account required.
 *
 * Flow:
 *   1. Collect demographics.
 *   2. POST /api/portal/register/patient (rate-limited, idempotent).
 *      Returns { patientId, hintPatientId?, regToken }.
 *   3. Save regToken in sessionStorage.
 *   4. Navigate to /register/eligibility (which uses the regToken to call
 *      protected portal-register endpoints).
 *
 * Account creation (Clerk) is a deferred step offered after booking.
 */

interface DemographicsData {
  firstname: string;
  lastname: string;
  dob: string;
  sex: string;
  email: string;
  mobilephone: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  // Extended demographics — align with Athena / MIDI flow defaults. All
  // optional from the patient's perspective; server applies MIDI-aligned
  // defaults ("declined" / "false") for anything left blank.
  race: string;
  ethnicitycode: string;
  medicareEnrolled: string;
  referralSource: string;
  consenttocall: boolean;
  consenttotext: boolean;
}

// Race + Ethnicity selectors were intentionally removed from the wizard UI
// to shorten the registration form. We still POST `race=declined` and
// `ethnicitycode=declined` (HL7 "prefer not to say") on the patient record
// so Athena's required demographic fields are populated.

// DOB picker — Month/Day/Year split. Users (especially older patients on
// mobile Safari) struggled with the native <input type="date"> spinner;
// splitting into three labeled selects is significantly more accessible.
// The canonical value in form.dob stays `YYYY-MM-DD` so the API payload,
// draft persistence, and validation logic are untouched.
const DOB_MONTHS = [
  { value: "01", label: "January" },
  { value: "02", label: "February" },
  { value: "03", label: "March" },
  { value: "04", label: "April" },
  { value: "05", label: "May" },
  { value: "06", label: "June" },
  { value: "07", label: "July" },
  { value: "08", label: "August" },
  { value: "09", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];
const DOB_DAYS = Array.from({ length: 31 }, (_, i) =>
  String(i + 1).padStart(2, "0")
);
// Year list runs from this year back to (this year - 130). The dropdown
// scrolls to 1950 on open when no year has been picked yet (see
// `defaultYearOnOpen` handler below). 1950 is the median DOB year for our
// patient population, so opening at "today - 30" was burying it 30 scrolls
// down.
const DOB_DEFAULT_YEAR = "1950";
const DOB_YEARS = (() => {
  const now = new Date().getFullYear();
  const years: string[] = [];
  for (let y = now; y >= now - 130; y--) years.push(String(y));
  return years;
})();

function splitDob(iso: string): { m: string; d: string; y: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!match) return { m: "", d: "", y: "" };
  return { y: match[1], m: match[2], d: match[3] };
}

function joinDob(parts: { m: string; d: string; y: string }): string {
  if (!parts.y || !parts.m || !parts.d) return "";
  return `${parts.y}-${parts.m}-${parts.d}`;
}

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
];

const REFERRAL_OPTIONS = [
  "Radio",
  "Mail",
  "Google",
  "Facebook",
  "Television",
  "Newspaper",
  "Event",
  "Word of mouth",
  "Doctor Referral",
  "Insurance Provider / Broker",
  "Other / I don't know",
] as const;

const DEFAULT_DEPARTMENT_ID = getPortalDefaultDepartmentId();

interface RegisterPatientResponse {
  patientId?: string;
  hintPatientId?: string;
  regToken?: string;
  duplicate?: boolean;
  message?: string;
}

function formatPhoneE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

/**
 * Progressive US-phone display formatter for the mobile phone input.
 * Accepts whatever the user types (digits, parens, dashes, spaces) and
 * returns a partially-formatted string in the canonical
 * `(123) 456-7890` shape so the value is readable while typing.
 *
 * Strips the leading "1" from 11-digit input so users who include a
 * country code see the same display as users who don't. Caps at 10
 * digits — anything longer would be invalid for NANP anyway. The
 * validation step (formatPhoneE164) is still the source of truth and
 * will re-reject anything outside 10-digit / +1xxxxxxxxxx.
 */
function formatPhoneAsTyped(raw: string): string {
  const digits = raw
    .replace(/\D/g, "")
    .replace(/^1(?=\d{10}$)/, "")
    .slice(0, 10);
  if (digits.length === 0) return "";
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

const DEFAULT_DEMOGRAPHICS: DemographicsData = {
  firstname: "",
  lastname: "",
  dob: "",
  sex: "F",
  email: "",
  mobilephone: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  race: "declined",
  ethnicitycode: "declined",
  medicareEnrolled: "",
  referralSource: "",
  // Default to opt-in for the two consents the patient is implicitly giving
  // by starting the self-serve registration flow. They can uncheck either
  // one before continuing.
  consenttocall: true,
  consenttotext: true,
};

export function RegistrationWizard() {
  const router = useRouter();

  const [error, setError] = useState("");
  const [duplicateMessage, setDuplicateMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [showOfframp, setShowOfframp] = useState(false);
  // Always render with defaults on the server pass; the persisted draft is
  // applied in a post-mount effect to avoid hydration mismatches when
  // sessionStorage holds values the server can't see.
  const [form, setForm] = useState<DemographicsData>(DEFAULT_DEMOGRAPHICS);
  const [hydrated, setHydrated] = useState(false);
  // Local state for the three DOB sub-selects. The canonical value
  // (`form.dob`) is only populated once all three parts are filled, so
  // we need somewhere to remember partial selections. Initialized from
  // any pre-filled form.dob (e.g. a draft restore) via the effect below.
  const [dobParts, setDobParts] = useState<{
    m: string;
    d: string;
    y: string;
  }>({ m: "", d: "", y: "" });

  // Rehydrate from the per-tab draft so navigating Back from a later step
  // doesn't wipe what the user already typed. Defensively merge onto the
  // current defaults so an older stored payload missing newer fields still
  // works.
  //
  // The setState calls here intentionally run inside an effect (not a
  // useState initializer) so SSR renders the empty defaults and the client
  // post-hydrates from sessionStorage — that's the only way to read storage
  // without producing a hydration mismatch. The repo's standard escape hatch
  // for this pattern is the same eslint-disable used in
  // create-account/[[...sign-up]]/page.tsx.
  useEffect(() => {
    const draft = loadRegistrationDraft<Partial<DemographicsData>>(
      "demographics"
    );
    if (draft) {
      // Drop empty-string values from the saved draft so they can't
      // clobber a meaningful default. Critical for `sex` (which must
      // stay "F" so Female is pre-selected on every visit) and for
      // `referralSource` (the user's previous pick should never be
      // erased by a stale empty save from an older deploy that wrote
      // "" before the field was required). `null`/`undefined` are
      // already filtered by spread; we just need to handle "".
      const sanitized: Partial<DemographicsData> = {};
      for (const [k, v] of Object.entries(draft) as [
        keyof DemographicsData,
        DemographicsData[keyof DemographicsData],
      ][]) {
        if (v === "" || v === undefined || v === null) continue;
        (sanitized as Record<string, unknown>)[k] = v;
      }

      setForm((prev) => ({ ...prev, ...sanitized }));
      if (typeof sanitized.dob === "string" && sanitized.dob) {
        setDobParts(splitDob(sanitized.dob));
      }
    }

    setHydrated(true);
  }, []);

  // Persist on every change, but only after the initial rehydrate has run —
  // otherwise the first effect would overwrite a real draft with the empty
  // defaults during the client's first render pass.
  useEffect(() => {
    if (!hydrated) return;
    saveRegistrationDraft("demographics", form);
  }, [form, hydrated]);

  // Fire registration_started exactly once per wizard mount, AFTER
  // hydration so we don't double-count Back-navigations from later
  // wizard steps (those re-mount but the draft was already saved).
  // The marketing attribution snapshot tells us what brought the
  // patient here without leaking any PHI.
  // Dedupe `registration_started` across remounts (back-nav,
  // re-renders, HMR). A component-local useRef resets every time the
  // route remounts, so persist a sticky marker in sessionStorage —
  // scoped to the tab so a fresh tab still fires the event. We keep
  // the useRef as a SSR-safe in-memory short-circuit before the
  // storage check.
  const STARTED_STORAGE_KEY = "hh.posthog.registration_started";
  const startedFired = useRef(false);
  useEffect(() => {
    if (!hydrated || startedFired.current) return;
    try {
      if (typeof window !== "undefined" &&
          window.sessionStorage?.getItem(STARTED_STORAGE_KEY) === "1") {
        startedFired.current = true;
        return;
      }
    } catch {
      // storage disabled (Safari private mode etc.) — fall through and
      // accept best-effort in-memory dedupe only.
    }
    startedFired.current = true;
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage?.setItem(STARTED_STORAGE_KEY, "1");
      }
    } catch {
      // ignore
    }
    const attribution = getAttribution();
    trackRegistrationStarted({
      source: "wizard",
      leadSource: resolveLeadSourceFromAttribution(attribution),
      utmCampaign: attribution.utm_campaign,
      utmSource: attribution.utm_source,
      utmMedium: attribution.utm_medium,
      utmContent: attribution.utm_content,
      landingPage: attribution.landing_page,
    });
  }, [hydrated]);

  function updateField(
    field: keyof DemographicsData,
    value: string | boolean
  ) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setDuplicateMessage("");

    const phone = formatPhoneE164(form.mobilephone);
    if (!phone) {
      setError("Please enter a valid 10-digit mobile phone number.");
      return;
    }
    const email = form.email.trim();
    // Email is required because the membership step (Hint billing) refuses
    // to enroll a patient without one. Validating up-front avoids a dead-end
    // mid-wizard where the only path forward is to start over.
    if (!email) {
      setError("Please enter your email address.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }
    // Athena's POST /patients enforces an undocumented 50-character cap on
    // `email`. Catch it here so we don't soft-fail patient_create at the
    // BFF and dead-end the wizard. See SF incident 2026-05-19 (future-DOB / email-cap).
    if (email.length > 50) {
      setError("Email is too long. Please use an address 50 characters or shorter.");
      return;
    }
    // DOB must be a real past calendar date with the patient at least 18.
    // <Input type="date"> alone doesn't block future dates (per the
    // 2026-05-19 future-DOB incident a user entered 2026-07-04 and the
    // wizard soft-failed at Athena instead of here). It also accepts
    // impossible calendar dates (Feb 31, Apr 31) which `new Date()`
    // silently normalizes into a different valid date — we re-parse the
    // Y/M/D components and verify round-trip to catch that.
    if (!form.dob || !/^\d{4}-\d{2}-\d{2}$/.test(form.dob)) {
      setError("Please select your birth month, day, and year.");
      return;
    }
    const [dobY, dobM, dobD] = form.dob.split("-").map(Number);
    const dobDate = new Date(dobY, dobM - 1, dobD);
    if (
      Number.isNaN(dobDate.getTime()) ||
      dobDate.getFullYear() !== dobY ||
      dobDate.getMonth() + 1 !== dobM ||
      dobDate.getDate() !== dobD
    ) {
      setError("That date doesn't exist. Please double-check the day.");
      return;
    }
    const today = new Date();
    if (dobDate > today) {
      setError("Date of birth can't be in the future.");
      return;
    }
    let age = today.getFullYear() - dobDate.getFullYear();
    const m = today.getMonth() - dobDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dobDate.getDate())) age--;
    if (age < 18) {
      setError("You must be at least 18 years old to register.");
      return;
    }
    if (age > 130) {
      setError("Please double-check your date of birth.");
      return;
    }
    if (!form.sex) {
      setError("Please select sex.");
      return;
    }
    if (!form.medicareEnrolled) {
      setError("Please answer the Medicare coverage question.");
      return;
    }
    if (!form.referralSource) {
      setError("Please tell us how you first heard about us.");
      return;
    }

    setLoading(true);
    const attribution = getAttribution();
    const result = await registerFetch<RegisterPatientResponse>(
      "/api/portal/register/patient",
      {
        method: "POST",
        body: JSON.stringify({
          firstname: form.firstname.trim(),
          lastname: form.lastname.trim(),
          dob: form.dob,
          sex: form.sex,
          mobilephone: phone,
          email,
          address1: form.address1.trim() || undefined,
          address2: form.address2.trim() || undefined,
          city: form.city.trim() || undefined,
          state: form.state || undefined,
          zip: form.zip.trim() || undefined,
          departmentid: DEFAULT_DEPARTMENT_ID,
          // Marketing attribution captured from URL params / sessionStorage on
          // landing pages. Forwarded straight to the Salesforce Lead.
          utm_source: attribution.utm_source,
          utm_medium: attribution.utm_medium,
          utm_campaign: attribution.utm_campaign,
          utm_content: attribution.utm_content,
          utm_term: attribution.utm_term,
          utm_id: attribution.utm_id,
          gclid: attribution.gclid,
          msclkid: attribution.msclkid,
          fbclid: attribution.fbclid,
          landingpage: attribution.landing_page,
          referrer: attribution.referrer,
          // Per-page LeadSource: pages can link with
          // /register?leadsource=newpatients OR rely on referrer-
          // derived pathname (e.g. arriving from /newpatients).
          // The server normalizes via normalizeLeadSource().
          leadSource: resolveLeadSourceFromAttribution(attribution),
          // MIDI-aligned extended demographics. The server falls back to
          // "declined" / "false" when these are absent, so we only send the
          // ones the patient actually answered. Consent checkboxes always
          // send because they always have a value.
          race: form.race || undefined,
          ethnicitycode: form.ethnicitycode || undefined,
          medicareenrolled: form.medicareEnrolled || undefined,
          referralsource: form.referralSource || undefined,
          consenttocall: form.consenttocall ? "true" : "false",
          consenttotext: form.consenttotext ? "true" : "false",
        }),
      }
    );
    setLoading(false);

    if (!result.ok || !result.data) {
      setError(result.error?.error || "Something went wrong. Please try again.");
      return;
    }

    if (result.data.duplicate) {
      setDuplicateMessage(
        result.data.message ||
        "We may already have a record for you. Please sign in to continue."
      );
      return;
    }

    if (!result.data.regToken || !result.data.patientId) {
      setError("Registration didn't return the expected response. Please try again.");
      return;
    }

    saveRegistration({
      regToken: result.data.regToken,
      patientId: result.data.patientId,
      hintPatientId: result.data.hintPatientId,
      firstName: form.firstname.trim(),
      lastName: form.lastname.trim(),
      email,
      phone,
    });

    // TOS / Privacy acceptance on Continue — enable full PostHog for step 2+.
    recordRegistrationAnalyticsConsent();

    trackRegistrationDemographicsSubmitted({
      medicareEnrolled: form.medicareEnrolled === "yes" ? "yes" : "no",
      departmentId: DEFAULT_DEPARTMENT_ID,
      state: form.state || undefined,
    });

    // Non-Medicare patients get an off-ramp instead of proceeding through the
    // insurance → membership → scheduling flow.
    if (form.medicareEnrolled === "no") {
      trackRegistrationOffRamp({ reason: "medicare_no" });
      setShowOfframp(true);
      return;
    }

    router.push("/register/eligibility");
  }

  // ─── Off-ramp screen (non-Medicare) ──────────────────────────────────────
  if (showOfframp) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 mb-4">
              <Image
                src={PORTAL_LOGO_URL}
                alt={PORTAL_LOGO_ALT}
                width={PORTAL_LOGO_WIDTH}
                height={PORTAL_LOGO_HEIGHT}
                priority
                unoptimized
                className="h-10 w-auto"
              />
            </div>
            <h1 className="text-xl font-medium text-foreground">
              New Patient Registration
            </h1>
            <p className="mt-2 text-muted-foreground">
              Tell us about yourself to get started with your care.
            </p>
          </div>

          <Card>
            <CardContent className="py-10 px-6 text-center space-y-6">
              <h2 className="font-serif text-2xl font-medium text-foreground leading-snug">
                Thank you for your interest in becoming a patient at Herself Health!
              </h2>

              <p className="text-base text-foreground leading-relaxed">
                For women 50+ on employer-provided or private insurance, we offer
                a membership program that provides comprehensive primary care
                services.
              </p>

              <p className="text-base text-foreground leading-relaxed">
                Please call{" "}
                <a
                  href="tel:+18882901209"
                  className="font-semibold whitespace-nowrap"
                >
                  555-123-4567
                </a>{" "}
                or visit{" "}
                <a
                  href="https://example-patient-portal.com/membership"
                  className="font-medium text-primary underline underline-offset-2"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  example-patient-portal.com/membership
                </a>{" "}
                to become a patient or receive more information.
              </p>

              <div className="pt-2">
                <Button
                  variant="outline"
                  size="lg"
                  className="rounded-xl border-primary text-primary hover:bg-primary/5"
                  asChild
                >
                  <Link href="/">
                    <ArrowLeft className="h-4 w-4" />
                    Close and Return to Home Page
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // ─── Demographics form ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-4">
            <Image
              src={PORTAL_LOGO_URL}
              alt={PORTAL_LOGO_ALT}
              width={PORTAL_LOGO_WIDTH}
              height={PORTAL_LOGO_HEIGHT}
              priority
              unoptimized
              className="h-10 w-auto"
            />
          </div>
          <h1 className="text-xl font-medium text-foreground">
            Schedule your first visit
          </h1>
          <p className="mt-2 text-muted-foreground">
            Tell us a little about yourself so we can confirm your insurance and
            help you choose an appointment time.
          </p>
        </div>

        <div className="flex items-center gap-2 mb-8">
          {(getClientPortalFeatureFlags().membership
            ? ["Your info", "Insurance", "Membership", "Choose a visit time"]
            : ["Your info", "Insurance", "Choose a visit time"]
          ).map(
            (label, i) => (
              <div key={label} className="flex-1">
                <div
                  className={cn(
                    "h-1.5 rounded-full",
                    i === 0 ? "bg-primary" : "bg-muted"
                  )}
                />
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  {label}
                </p>
              </div>
            )
          )}
        </div>

        <div className="mb-6 flex items-start gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2.5">
          <Lock
            className="mt-0.5 h-4 w-4 shrink-0 text-primary"
            aria-hidden
          />
          <div className="text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">
              Your information is secure and protected
            </p>
            <p className="mt-0.5">
              Your personal and insurance details are encrypted in transit and at
              rest, kept private in accordance with HIPAA, and never sold. See
              our Privacy Policy below.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="space-y-5 pt-6">
            <form
              onSubmit={handleSubmit}
              className="space-y-5"
              noValidate
            >
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstname">First name *</Label>
                  <Input
                    id="firstname"
                    type="text"
                    required
                    value={form.firstname}
                    onChange={(e) => updateField("firstname", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastname">Last name *</Label>
                  <Input
                    id="lastname"
                    type="text"
                    required
                    value={form.lastname}
                    onChange={(e) => updateField("lastname", e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="dob-month">Date of birth *</Label>
                  <div className="grid grid-cols-[1.4fr_0.9fr_1fr] gap-2">
                    <Select
                      value={dobParts.m}
                      onValueChange={(v) => {
                        const next = { ...dobParts, m: v };
                        setDobParts(next);
                        updateField("dob", joinDob(next));
                      }}
                    >
                      <SelectTrigger
                        id="dob-month"
                        aria-label="Birth month"
                        className="w-full h-9 py-1 md:text-sm"
                        style={{ minHeight: "unset" }}
                      >
                        <SelectValue placeholder="Month" />
                      </SelectTrigger>
                      <SelectContent>
                        {DOB_MONTHS.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={dobParts.d}
                      onValueChange={(v) => {
                        const next = { ...dobParts, d: v };
                        setDobParts(next);
                        updateField("dob", joinDob(next));
                      }}
                    >
                      <SelectTrigger
                        id="dob-day"
                        aria-label="Birth day"
                        className="w-full h-9 py-1 md:text-sm"
                        style={{ minHeight: "unset" }}
                      >
                        <SelectValue placeholder="Day" />
                      </SelectTrigger>
                      <SelectContent>
                        {DOB_DAYS.map((d) => (
                          <SelectItem key={d} value={d}>
                            {String(parseInt(d, 10))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={dobParts.y}
                      onValueChange={(v) => {
                        const next = { ...dobParts, y: v };
                        setDobParts(next);
                        updateField("dob", joinDob(next));
                      }}
                      onOpenChange={(open) => {
                        // Default the visible year to 1950 when the user opens the
                        // dropdown for the first time. We don't pre-populate
                        // form.dob — the user must still actively select a year —
                        // we just scroll the listbox so 1950 is centered and
                        // focused on open.
                        if (!open) return;
                        if (dobParts.y) return;
                        requestAnimationFrame(() => {
                          const item = document.querySelector<HTMLElement>(
                            `[role="option"][data-dob-default-year="${DOB_DEFAULT_YEAR}"]`
                          );
                          if (!item) return;
                          item.scrollIntoView({ block: "center" });
                          // Move keyboard focus too so arrow keys start at 1950.
                          item.focus({ preventScroll: true });
                        });
                      }}
                    >
                      <SelectTrigger
                        id="dob-year"
                        aria-label="Birth year"
                        className="w-full h-9 py-1 md:text-sm"
                        style={{ minHeight: "unset" }}
                      >
                        <SelectValue placeholder="Year" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {DOB_YEARS.map((y) => (
                          <SelectItem
                            key={y}
                            value={y}
                            data-dob-default-year={
                              y === DOB_DEFAULT_YEAR ? y : undefined
                            }
                          >
                            {y}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sex">Sex *</Label>
                  <Select
                    value={form.sex}
                    onValueChange={(v) => updateField("sex", v)}
                  >
                    <SelectTrigger id="sex" className="w-full h-9 py-1 md:text-sm" style={{ minHeight: 'unset' }}>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="F">Female</SelectItem>
                      <SelectItem value="M">Male</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="mobilephone">Mobile phone *</Label>
                <Input
                  id="mobilephone"
                  type="tel"
                  required
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={form.mobilephone}
                  onChange={(e) =>
                    updateField("mobilephone", formatPhoneAsTyped(e.target.value))
                  }
                  placeholder="(555) 123-4567"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => updateField("email", e.target.value)}
                  placeholder="you@example.com"
                  maxLength={50}
                />
              </div>

              <AddressAutocomplete
                value={form.address1}
                onChange={(v) => updateField("address1", v)}
                onResolved={(addr) => {
                  setForm((prev) => ({
                    ...prev,
                    address1: addr.address1 || prev.address1,
                    address2: addr.address2 || prev.address2,
                    city: addr.city || prev.city,
                    state: addr.state || prev.state,
                    zip: addr.zip || prev.zip,
                  }));
                }}
              />

              <div className="space-y-2">
                <Label htmlFor="address2">Apt / Suite (optional)</Label>
                <Input
                  id="address2"
                  type="text"
                  value={form.address2}
                  onChange={(e) => updateField("address2", e.target.value)}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    type="text"
                    value={form.city}
                    onChange={(e) => updateField("city", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Select
                    value={form.state}
                    onValueChange={(v) => updateField("state", v)}
                  >
                    <SelectTrigger id="state" className="w-full h-9 py-1 md:text-sm" style={{ minHeight: 'unset' }}>
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {US_STATES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zip">ZIP</Label>
                  <Input
                    id="zip"
                    type="text"
                    value={form.zip}
                    onChange={(e) => updateField("zip", e.target.value)}
                    maxLength={5}
                  />
                </div>
              </div>

              {/* Race + Ethnicity selectors removed from the UI; the form
                  state still defaults to `race="declined"` and
                  `ethnicitycode="declined"` so the patient record is created
                  with HL7 "prefer not to say" for both. */}

              <div className="space-y-3">
                <p className="text-base font-medium text-foreground">
                  Medicare or Medicare Advantage Coverage *
                </p>
                <p className="text-sm text-foreground">
                  Are you currently enrolled in a Medicare or Medicare Advantage plan?
                </p>
                <RadioGroup
                  className="flex items-center gap-6 mt-2"
                  value={form.medicareEnrolled}
                  onValueChange={(v) => updateField("medicareEnrolled", v)}
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="yes" id="medicare-yes" style={{ minHeight: 'unset', minWidth: 'unset' }} />
                    <Label htmlFor="medicare-yes" className="font-normal text-sm">
                      Yes
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="no" id="medicare-no" style={{ minHeight: 'unset', minWidth: 'unset' }} />
                    <Label htmlFor="medicare-no" className="font-normal text-sm">
                      No
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <Label htmlFor="referralSource">
                  How did you first hear about us? *
                </Label>
                <Select
                  value={form.referralSource}
                  onValueChange={(v) => updateField("referralSource", v)}
                >
                  <SelectTrigger id="referralSource" className="w-full h-9 py-1 md:text-sm" style={{ minHeight: 'unset' }}>
                    <SelectValue placeholder="Select one" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {REFERRAL_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-sm font-medium text-foreground">
                  Communication preferences
                </p>
                {/* Phone-call consent (`consenttocall`) is no longer surfaced
                    as a checkbox — the form state keeps it `true` by default
                    so the patient record is still flagged opted-in. Only the
                    SMS consent stays interactive so the patient can opt out
                    of texts. */}
                <label
                  htmlFor="consenttotext"
                  className="flex items-start gap-3 cursor-pointer"
                >
                  <input
                    id="consenttotext"
                    type="checkbox"
                    checked={form.consenttotext}
                    onChange={(e) =>
                      updateField("consenttotext", e.target.checked)
                    }
                    className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-sm text-muted-foreground">
                    {SMS_CONSENT_CHECKBOX_TEXT}
                  </span>
                </label>
              </div>

              {duplicateMessage && (
                <Alert>
                  <AlertTitle>Looks like you&apos;re already with us</AlertTitle>
                  <AlertDescription>
                    {duplicateMessage}
                    {getClientPortalFeatureFlags().authUi && (
                      <>
                        {" "}
                        <Link href="/login" className="font-medium underline">
                          Sign in
                        </Link>
                        .
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {getClientPortalFeatureFlags().authUi && (
                <p className="text-xs text-muted-foreground">
                  You can complete registration, add insurance, and book your
                  first visit without creating an account. We&apos;ll offer to set
                  up a login afterwards.
                </p>
              )}

              {getClientPortalFeatureFlags().authUi && (
                <p className="text-xs text-muted-foreground">
                  Already registered?{" "}
                  <Link href="/login" className="font-medium underline">
                    Sign in
                  </Link>
                </p>
              )}

              <p className="text-xs text-muted-foreground leading-relaxed">
                By continuing, you agree to our{" "}
                <Link
                  href={PRIVACY_POLICY_HREF}
                  className="underline hover:text-foreground"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Privacy Policy
                </Link>{" "}
                and{" "}
                <Link
                  href={TERMS_OF_SERVICE_HREF}
                  className="underline hover:text-foreground"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Terms of Service
                </Link>
                .
              </p>

              <div className="flex items-center justify-between pt-2">
                <p className="text-sm text-muted-foreground">
                  Have a question? We&apos;re just a call away at{" "}
                  <a
                    href="tel:+18882901209"
                    className="font-medium text-foreground whitespace-nowrap"
                  >
                    555-123-4567
                  </a>
                  , Option 2
                </p>
                <Button
                  type="submit"
                  size="lg"
                  className="rounded-xl shrink-0 ml-4"
                  disabled={loading}
                >
                  {loading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      Continue
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
