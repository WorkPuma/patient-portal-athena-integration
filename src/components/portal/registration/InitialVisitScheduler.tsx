"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Calendar,
  Loader2,
  MapPin,
  Phone,
  CheckCircle2,
  ChevronRight,
  User,
  Stethoscope,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  loadRegistration,
  registerFetch,
} from "./registration-client";
import { getClientPortalFeatureFlags } from "@/lib/portal/feature-flags";
import {
  getRegistrationInitialVisitTypeId,
  getRegistrationVariantFromInsurance,
  type RegistrationVisitVariant,
} from "@/lib/scheduling/appointment-types";

interface PortalLocation {
  departmentid: number;
  slug: string;
  name: string;
  shortName: string;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
  /** Patient-facing one-liner without ZIP (server-formatted). */
  formattedAddress: string;
  phone: string | null;
}

interface PortalProvider {
  providerid: number;
  firstname: string;
  lastname: string;
  displayname: string;
  credentials: string | null;
  specialty: string | null;
  locations: string[];
  headshotUrl: string | null;
  headshotAlt: string | null;
  title: string | null;
  specializations: string | null;
  hasProfile: boolean;
}

interface Slot {
  appointmentid: string;
  date: string;
  starttime: string;
  duration: number;
  departmentid: string;
  providerid: string;
  providerfirstname?: string;
  providerlastname?: string;
  appointmenttype?: string;
  appointmenttypeid?: string;
}

type WizardStep = "location" | "provider" | "time";

function formatDate(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(
    date.getDate()
  ).padStart(2, "0")}/${date.getFullYear()}`;
}

function formatDisplayDate(dateStr: string): string {
  const [month, day, year] = dateStr.split("/");
  const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime(starttime: string): string {
  // Athena returns "HH:MM" in 24-hour. Convert to "h:mm AM/PM".
  const [hStr, m] = starttime.split(":");
  const h = parseInt(hStr, 10);
  if (!Number.isFinite(h)) return starttime;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m} ${ampm}`;
}

function providerInitials(p: { firstname: string; lastname: string }): string {
  return `${p.firstname.charAt(0)}${p.lastname.charAt(0)}`.toUpperCase();
}

export function InitialVisitScheduler() {
  const router = useRouter();

  const [step, setStep] = useState<WizardStep>("location");

  const [locations, setLocations] = useState<PortalLocation[] | null>(null);
  const [providers, setProviders] = useState<PortalProvider[] | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);

  const [selectedDepartmentId, setSelectedDepartmentId] = useState<number | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string>("");
  const [slotTakenId, setSlotTakenId] = useState<string | null>(null);

  const [loadingLocations, setLoadingLocations] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState("");

  // Branch the Initial Visit appointment type on the registrant's
  // insurance class. We read the persisted insurance once at mount —
  // this is set during the eligibility step and shouldn't change for
  // the remainder of the registration session. If insurance is missing
  // (rare, but possible in a Back-button race), `standard` is the safer
  // fallback because the 90-min Initial Visit pool is the more widely
  // templated of the two and any clinic that has an MBR slot also has a
  // standard one.
  const initialVisitVariant = useMemo<RegistrationVisitVariant>(() => {
    const reg = loadRegistration();
    return getRegistrationVariantFromInsurance(reg?.insurance);
  }, []);
  const initialVisitTypeId = useMemo(
    () => getRegistrationInitialVisitTypeId("in_person", initialVisitVariant),
    [initialVisitVariant]
  );

  // The scheduler intentionally does NOT persist Clinic / Clinician
  // selections across navigations. Slot inventory is short-lived (Athena
  // 60s cache + the slot can be taken between renders), and resuming
  // mid-flow into a stale clinic is more confusing than helpful. If the
  // patient leaves the page they restart from "pick a clinic" — same as
  // hitting the in-page Back button does for switching clinics.
  useEffect(() => {
    if (!loadRegistration()) {
      router.replace("/register");
    }
  }, [router]);

  // ─── Data fetchers ──────────────────────────────────────────────────────
  const fetchLocations = useCallback(async () => {
    setLoadingLocations(true);
    setError("");
    const result = await registerFetch<{ locations: PortalLocation[] }>(
      "/api/portal/register/locations"
    );
    if (result.ok && result.data) {
      setLocations(result.data.locations);
    } else {
      setError(result.error?.error || "Couldn't load clinic locations.");
    }
    setLoadingLocations(false);
  }, []);

  const fetchProviders = useCallback(async (locationSlug: string) => {
    setLoadingProviders(true);
    setError("");
    const result = await registerFetch<{ providers: PortalProvider[] }>(
      `/api/portal/register/providers?location=${encodeURIComponent(locationSlug)}`
    );
    if (result.ok && result.data) {
      setProviders(result.data.providers);
    } else {
      setError(result.error?.error || "Couldn't load providers.");
    }
    setLoadingProviders(false);
  }, []);

  const fetchSlots = useCallback(
    async (departmentId: number, providerId: number | null) => {
      setLoadingSlots(true);
      setError("");
      setSlotTakenId(null);
      const today = new Date();
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 30);
      const params = new URLSearchParams({
        startdate: formatDate(today),
        enddate: formatDate(endDate),
        appointmenttypeid: String(initialVisitTypeId),
        departmentid: String(departmentId),
      });
      if (providerId !== null) params.set("providerid", String(providerId));

      const result = await registerFetch<{ appointments: Slot[] }>(
        `/api/portal/register/appointments/available?${params.toString()}`
      );
      if (result.ok && result.data) {
        setSlots(result.data.appointments || []);
      } else {
        setError(result.error?.error || "Couldn't load available times.");
      }
      setLoadingSlots(false);
    },
    [initialVisitTypeId]
  );

  // ─── Step transitions ──────────────────────────────────────────────────
  // ─── Auto-fetch guards ───────────────────────────────────────────────────
  //
  // Each fetcher is allowed to run AT MOST ONCE per (step, key) pair. Without
  // this, a failing API (e.g. /locations 500) would loop forever:
  //   render -> useEffect -> fetch -> setError + setLoading(false) ->
  //   re-render -> useEffect (loading flipped back, locations still null) ->
  //   fetch again -> ...
  // The previous gate `!locations && !loadingLocations` was only true when
  // the fetch SUCCEEDED (locations set) OR was in flight; on an error it
  // collapsed back to true and re-fired. Using a key-keyed ref keeps the
  // attempt count to exactly 1 per user-visible step until the user
  // actually navigates back to the previous step or changes the key.
  const attemptedLocationsRef = useRef(false);
  const attemptedProvidersRef = useRef<string | null>(null);
  const attemptedSlotsRef = useRef<string | null>(null);

  // Clear the "did-attempt" markers whenever the user navigates between
  // steps. This way: (a) a failed first attempt doesn't loop, (b) when
  // the user manually goes back to a step the auto-fetch retries once.
  useEffect(() => {
    if (step !== "location") attemptedLocationsRef.current = false;
    if (step !== "provider") attemptedProvidersRef.current = null;
    if (step !== "time") attemptedSlotsRef.current = null;
  }, [step]);

  useEffect(() => {
    if (
      step === "location" &&
      !locations &&
      !loadingLocations &&
      !attemptedLocationsRef.current
    ) {
      attemptedLocationsRef.current = true;
       
      fetchLocations();
    }
  }, [step, locations, loadingLocations, fetchLocations]);

  const selectedLocation = useMemo(
    () =>
      locations?.find((l) => l.departmentid === selectedDepartmentId) ?? null,
    [locations, selectedDepartmentId]
  );
  const selectedProvider = useMemo(
    () =>
      providers?.find((p) => p.providerid === selectedProviderId) ?? null,
    [providers, selectedProviderId]
  );

  useEffect(() => {
    if (step === "provider" && selectedLocation) {
      const key = selectedLocation.slug;
      if (attemptedProvidersRef.current !== key) {
        attemptedProvidersRef.current = key;
         
        fetchProviders(key);
      }
    }
  }, [step, selectedLocation, fetchProviders]);

  useEffect(() => {
    if (step === "time" && selectedDepartmentId !== null) {
      const key = `${selectedDepartmentId}:${selectedProviderId ?? "any"}`;
      if (attemptedSlotsRef.current !== key) {
        attemptedSlotsRef.current = key;
         
        fetchSlots(selectedDepartmentId, selectedProviderId);
      }
    }
  }, [step, selectedDepartmentId, selectedProviderId, fetchSlots]);

  // ─── Handlers ──────────────────────────────────────────────────────────
  function chooseLocation(loc: PortalLocation) {
    setSelectedDepartmentId(loc.departmentid);
    setSelectedProviderId(null); // reset provider when location changes
    setProviders(null);
    setSlots(null);
    setSelectedSlotId("");
    setStep("provider");
  }

  function chooseProvider(providerId: number | null) {
    setSelectedProviderId(providerId);
    setSlots(null);
    setSelectedSlotId("");
    setStep("time");
  }

  function backToLocation() {
    setSelectedSlotId("");
    setSlots(null);
    setProviders(null);
    setStep("location");
  }
  function backToProvider() {
    setSelectedSlotId("");
    setSlots(null);
    setStep("provider");
  }

  async function handleBook() {
    if (!selectedSlotId) return;
    setBooking(true);
    setError("");
    setSlotTakenId(null);

    const slot = slots?.find((s) => s.appointmentid === selectedSlotId);

    const result = await registerFetch<{ appointment: Slot }>(
      "/api/portal/register/appointments/book",
      {
        method: "POST",
        body: JSON.stringify({
          appointmentId: parseInt(selectedSlotId, 10),
          appointmenttypeid: initialVisitTypeId,
          bookingnote:
            initialVisitVariant === "mbr"
              ? "MBR Initial Visit - scheduled via patient portal"
              : "Initial Visit - scheduled via patient portal",
          // Athena ids are forwarded so the BFF can resolve them to the
          // matching Salesforce Location and Contact (provider) records
          // for the Appointment__c lookups.
          departmentId: selectedLocation?.departmentid,
          providerId: selectedProvider?.providerid,
          locationName: selectedLocation?.name,
          providerName: selectedProvider?.displayname,
          // Always send the canonical Initial Visit name (NOT the raw
          // pool label like "Any 60 (AWV, PreOp, TOC)") so Salesforce's
          // Appointment.Appointment_Type__c reads cleanly. Athena's PUT
          // rewrites the slot to our queried typeid at book time, so
          // this rename is honest, not a fudge. See server-side
          // filterRegistrationInitialVisitSlots() — by the time we get
          // here, slot.duration already matches the variant.
          appointmentTypeName:
            initialVisitVariant === "mbr"
              ? "MBR - Initial Visit"
              : "Initial Visit",
          duration: slot?.duration,
        }),
      }
    );

    if (!result.ok) {
      if (result.status === 409) {
        setSlotTakenId(selectedSlotId);
        setSelectedSlotId("");
        setError(
          result.error?.error || "That time was just taken — please pick another."
        );
        if (selectedDepartmentId !== null) {
          await fetchSlots(selectedDepartmentId, selectedProviderId);
        }
      } else {
        setError(result.error?.error || "Booking failed");
      }
      setBooking(false);
      return;
    }

    if (slot) {
      try {
        sessionStorage.setItem(
          "hh_reg_booked_slot",
          JSON.stringify({
            ...slot,
            locationName: selectedLocation?.name,
            locationShortName: selectedLocation?.shortName,
            locationAddress: selectedLocation?.formattedAddress,
            providerName: selectedProvider?.displayname,
          })
        );
      } catch {
        /* confirmation page will degrade gracefully */
      }
    }
    router.push("/register/confirmation");
  }

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen px-4 py-10 md:py-14">
      <div className="mx-auto w-full max-w-2xl">
        <div className="text-center mb-8">
          <Calendar className="h-10 w-10 text-primary mx-auto mb-3" />
          <h1 className="text-2xl font-medium text-foreground">
            Schedule your first visit
          </h1>
          <p className="mt-2 text-muted-foreground">
            Initial visits are 90 minutes — plenty of time to meet your
            clinician and review your health goals.
          </p>
        </div>

        <RegistrationProgress />
        <SubStepHeader
          step={step}
          location={selectedLocation}
          provider={selectedProvider}
          providerId={selectedProviderId}
        />

        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {step === "location" && (
          <LocationStep
            locations={locations ?? []}
            loading={loadingLocations}
            selectedId={selectedDepartmentId}
            onSelect={chooseLocation}
          />
        )}

        {step === "provider" && selectedLocation && (
          <ProviderStep
            providers={providers ?? []}
            loading={loadingProviders}
            location={selectedLocation}
            selectedId={selectedProviderId}
            onSelect={chooseProvider}
          />
        )}

        {step === "time" && selectedLocation && (
          <TimeStep
            slots={slots ?? []}
            loading={loadingSlots}
            booking={booking}
            selectedSlotId={selectedSlotId}
            slotTakenId={slotTakenId}
            location={selectedLocation}
            providers={providers ?? []}
            onSelectSlot={setSelectedSlotId}
            onBook={handleBook}
          />
        )}

        <div className="mt-10 flex items-center justify-between">
          <Button
            variant="link"
            className="text-muted-foreground h-auto p-0"
            onClick={() => {
              if (step === "time") backToProvider();
              else if (step === "provider") backToLocation();
              else {
                const flags = getClientPortalFeatureFlags();
                router.push(
                  flags.membership
                    ? "/register/membership"
                    : "/register/eligibility",
                );
              }
            }}
          >
            <span className="inline-flex items-center gap-1">
              <ArrowLeft className="h-4 w-4" />
              Back
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function RegistrationProgress() {
  const labels = getClientPortalFeatureFlags().membership
    ? ["Your info", "Insurance", "Membership", "Choose a visit time"]
    : ["Your info", "Insurance", "Choose a visit time"];
  return (
    <div className="flex items-center gap-2 mb-6">
      {labels.map((label) => (
        <div key={label} className="flex-1">
          <div className="h-1.5 rounded-full bg-primary" />
          <p className="text-xs text-muted-foreground mt-1 text-center">
            {label}
          </p>
        </div>
      ))}
    </div>
  );
}

function SubStepHeader({
  step,
  location,
  provider,
  providerId,
}: {
  step: WizardStep;
  location: PortalLocation | null;
  provider: PortalProvider | null;
  providerId: number | null;
}) {
  if (step === "location") {
    return (
      <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">1. Choose a clinic</span>
        <ChevronRight className="h-3.5 w-3.5" />
        <span>2. Pick a clinician</span>
        <ChevronRight className="h-3.5 w-3.5" />
        <span>3. Book a time</span>
      </div>
    );
  }
  // Show the patient what they've picked, but intentionally NO inline
  // "change" affordance — switching clinic/clinician is "Back" only, so
  // the wizard can't end up with a stale clinic id paired to a fresh
  // provider list and vice versa.
  return (
    <div className="mb-6 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Clinic</span>
        <span className="font-medium text-foreground">
          {location?.shortName ?? "—"}
        </span>
      </div>
      {step === "time" && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Clinician</span>
          <span className="font-medium text-foreground">
            {providerId === null
              ? "Any clinician — first available"
              : provider?.displayname ?? "—"}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Use Back to switch clinic or clinician.
      </p>
    </div>
  );
}

function LocationStep({
  locations,
  loading,
  selectedId,
  onSelect,
}: {
  locations: PortalLocation[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (loc: PortalLocation) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (!locations.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No clinic locations are available right now. Please call us at
          <span className="block font-semibold mt-1">(612) 256-8225</span>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {locations.map((loc) => {
        const isSelected = selectedId === loc.departmentid;
        return (
          <button
            type="button"
            key={loc.departmentid}
            onClick={() => onSelect(loc)}
            className={cn(
              "w-full text-left rounded-2xl border bg-card p-5",
              "transition-all hover:border-primary/50 hover:shadow-md",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              isSelected && "border-primary ring-2 ring-primary/20"
            )}
          >
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <MapPin className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-foreground">
                    {loc.shortName || loc.name}
                  </h3>
                  {isSelected && (
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {loc.formattedAddress}
                </p>
                {loc.phone && (
                  <p className="text-sm text-muted-foreground mt-1 inline-flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5" />
                    {loc.phone}
                  </p>
                )}
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground/60 mt-1" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ProviderStep({
  providers,
  loading,
  location,
  selectedId,
  onSelect,
}: {
  providers: PortalProvider[];
  loading: boolean;
  location: PortalLocation;
  selectedId: number | null;
  onSelect: (providerId: number | null) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "w-full text-left rounded-2xl border bg-card p-5",
          "transition-all hover:border-primary/50 hover:shadow-md",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          selectedId === null && "border-primary ring-2 ring-primary/20"
        )}
      >
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Stethoscope className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-foreground">
              First available clinician
            </h3>
            <p className="text-sm text-muted-foreground">
              Show every open time at {location.shortName}.
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground/60" />
        </div>
      </button>

      {providers.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            No published clinician profiles for {location.shortName} yet —
            choose <em>First available clinician</em> above to see all open
            times.
          </CardContent>
        </Card>
      ) : (
        providers.map((p) => {
          const isSelected = selectedId === p.providerid;
          return (
            <button
              type="button"
              key={p.providerid}
              onClick={() => onSelect(p.providerid)}
              className={cn(
                "w-full text-left rounded-2xl border bg-card p-5",
                "transition-all hover:border-primary/50 hover:shadow-md",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                isSelected && "border-primary ring-2 ring-primary/20"
              )}
            >
              <div className="flex items-start gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground">
                  {p.headshotUrl ? (
                    // Storyblok image domain — Image with `unoptimized` keeps
                    // us off Vercel's image-transform allowlist requirement.
                    <Image
                      src={p.headshotUrl}
                      alt={p.headshotAlt || `${p.displayname} headshot`}
                      width={64}
                      height={64}
                      className="h-full w-full object-cover object-top"
                      unoptimized
                    />
                  ) : (
                    <span className="text-sm font-semibold">
                      {providerInitials(p)}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-foreground truncate">
                      {p.displayname}
                    </h3>
                    {isSelected && (
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    )}
                  </div>
                  {p.title && (
                    <p className="text-sm text-foreground/80">{p.title}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {p.specialty ?? "Primary care"}
                    {p.credentials ? ` · ${p.credentials}` : ""}
                  </p>
                  {p.specializations && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {p.specializations}
                    </p>
                  )}
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground/60 mt-1 shrink-0" />
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

function TimeStep({
  slots,
  loading,
  booking,
  selectedSlotId,
  slotTakenId,
  location,
  providers,
  onSelectSlot,
  onBook,
}: {
  slots: Slot[];
  loading: boolean;
  booking: boolean;
  selectedSlotId: string;
  slotTakenId: string | null;
  location: PortalLocation;
  providers: PortalProvider[];
  onSelectSlot: (id: string) => void;
  onBook: () => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-4 py-6">
        <Skeleton className="h-5 w-40" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
        <Skeleton className="h-5 w-40 mt-2" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center pt-8 pb-8 text-center">
          <Calendar className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground mb-1">
            No 90-minute Initial Visit times in the next 30 days at{" "}
            {location.shortName}.
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            Try a different clinician or location, or call us to schedule.
          </p>
          {location.phone && (
            <p className="text-sm font-medium">
              <Phone className="inline h-4 w-4 mr-1" />
              {location.phone}
            </p>
          )}
          <Button variant="link" className="text-primary mt-3" asChild>
            <Link href="/login">Go to portal</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const slotsByDate = slots.reduce<Record<string, Slot[]>>((acc, s) => {
    if (!acc[s.date]) acc[s.date] = [];
    acc[s.date].push(s);
    return acc;
  }, {});

  const providerById = new Map(providers.map((p) => [p.providerid, p]));

  return (
    <div className="space-y-6">
      {Object.entries(slotsByDate)
        .slice(0, 7)
        .map(([date, dateSlots]) => (
          <div key={date}>
            <h3 className="text-sm font-medium text-foreground mb-2">
              {formatDisplayDate(date)}
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {dateSlots.map((slot) => {
                const taken = slotTakenId === slot.appointmentid;
                const isSelected = selectedSlotId === slot.appointmentid;
                const providerName =
                  providerById.get(parseInt(slot.providerid, 10))
                    ?.displayname ||
                  [slot.providerfirstname, slot.providerlastname]
                    .filter(Boolean)
                    .join(" ") ||
                  null;
                return (
                  <button
                    type="button"
                    key={slot.appointmentid}
                    disabled={taken}
                    onClick={() => onSelectSlot(slot.appointmentid)}
                    className={cn(
                      "rounded-xl border px-2 py-2 text-sm font-medium transition-all",
                      "hover:border-primary/50 hover:shadow-sm",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "bg-card text-foreground",
                      taken && "opacity-40 line-through pointer-events-none"
                    )}
                  >
                    <div>{formatTime(slot.starttime)}</div>
                    {providerName && (
                      <div
                        className={cn(
                          "text-[10px] mt-0.5 truncate",
                          isSelected
                            ? "text-primary-foreground/80"
                            : "text-muted-foreground"
                        )}
                      >
                        <User className="inline h-2.5 w-2.5 mr-0.5" />
                        {providerName}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      <div className="flex items-center justify-end pt-2">
        <Button
          size="lg"
          className="rounded-xl min-w-[12rem]"
          onClick={onBook}
          disabled={!selectedSlotId || booking}
        >
          {booking ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            "Book appointment"
          )}
        </Button>
      </div>
    </div>
  );
}
