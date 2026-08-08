"use client";

/**
 * StandaloneScheduling — the no-login scheduling experience reached from an
 * opaque one-time SMS link (`/schedule?t=<token>`).
 *
 * Design priorities (75% mobile, senior-friendly):
 *   - Single column, generous spacing, large (>=56px) touch targets.
 *   - Large, high-contrast type; plain-language copy.
 *   - One decision per screen; an obvious Back control.
 *   - `aria-live` status region; `aria-pressed` on selectable options.
 *
 * Two entry branches resolved server-side (mode):
 *   - "reschedule": patient cancelled a visit within 30 days → ask whether
 *     to rebook the same visit, or start fresh because symptoms changed.
 *   - "schedule": start from their clinic + PCP, then pick a reason + time.
 *
 * A tier-cadence nudge encourages booking on tier; MDDO / AWV follow-up
 * suggestions appear at the bottom when the patient is eligible.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Building2,
  Video,
  Stethoscope,
  HeartPulse,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getAppointmentType,
  type PortalCategory,
  type VisitModality,
} from "@/lib/scheduling/appointment-types";

// ─── Types mirroring /api/portal/schedule-link/session ──────────────────────

interface RecentCancellation {
  appointmentId: string;
  date: string;
  appointmentTypeId: string | null;
  appointmentType: string | null;
  providerId: string | null;
  providerName: string | null;
  departmentId: string | null;
}

interface ClinicOption {
  departmentId: string;
  name: string;
}

interface SessionData {
  ok: true;
  mode: "reschedule" | "schedule";
  patient: { firstName: string | null };
  recentCancellation: RecentCancellation | null;
  clinic: { departmentId: string; name: string } | null;
  pcp: { providerId: string; name: string } | null;
  tier: {
    label: string;
    visitsPerYear: number;
    cadenceLabel: string;
    offCadence: boolean | null;
    message: string;
  } | null;
  followUps: { mddo: boolean; awv: boolean };
  clinics: ClinicOption[];
}

interface Slot {
  appointmentid: string | number;
  date: string;
  starttime: string;
  duration?: number;
  providerid?: string | number;
  providerfirstname?: string;
  providerlastname?: string;
  departmentid?: string | number;
}

type Step =
  | "loading"
  | "link_error"
  | "reschedule_choice"
  | "reason"
  | "time"
  | "confirm"
  | "success";

// ─── Date / slot helpers ────────────────────────────────────────────────────

function mmddyyyy(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

function prettyDate(mdy: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy.trim());
  if (!m) return mdy;
  const [, mm, dd, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function prettyTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

function slotProvider(s: Slot): string {
  return (
    [s.providerfirstname, s.providerlastname].filter(Boolean).join(" ").trim() ||
    "Available provider"
  );
}

function groupByDate(slots: Slot[]): Array<{ date: string; slots: Slot[] }> {
  const map = new Map<string, Slot[]>();
  for (const s of slots) {
    const key = String(s.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return Array.from(map.entries())
    .map(([date, list]) => ({
      date,
      slots: list.sort((a, b) =>
        String(a.starttime).localeCompare(String(b.starttime))
      ),
    }))
    .sort((a, b) => {
      const da = new Date(a.date).getTime();
      const db = new Date(b.date).getTime();
      return da - db;
    });
}

// ─── Reason model ───────────────────────────────────────────────────────────

interface ReasonOption {
  category: PortalCategory;
  label: string;
  description: string;
  icon: typeof Stethoscope;
}

const REASON_OPTIONS: ReasonOption[] = [
  {
    category: "routine",
    label: "Routine visit",
    description: "Follow-up, check-in, or ongoing care",
    icon: Stethoscope,
  },
  {
    category: "urgent",
    label: "Something's bothering me",
    description: "A new or urgent symptom",
    icon: HeartPulse,
  },
  {
    category: "awv",
    label: "Annual Wellness Visit",
    description: "Your yearly Medicare wellness visit",
    icon: CalendarCheck,
  },
];

export function StandaloneScheduling({ token }: { token: string | null }) {
  const [step, setStep] = useState<Step>("loading");
  const [linkErrorMsg, setLinkErrorMsg] = useState<string | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);

  // Selections
  const [modality, setModality] = useState<VisitModality>("in_person");
  const [category, setCategory] = useState<PortalCategory | null>(null);
  const [departmentId, setDepartmentId] = useState<string>("");
  const [appointmentTypeId, setAppointmentTypeId] = useState<number | null>(null);
  const [appointmentTypeName, setAppointmentTypeName] = useState<string>("");
  // When set, we rebook the cancelled visit ("same visit") instead of a new reason.
  const [rebookSameVisit, setRebookSameVisit] = useState(false);

  // Slots
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);

  // Booking
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);

  // ── Load session ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setStep("link_error");
      setLinkErrorMsg(
        "This link is missing its secure code. Please use the link from your text message, or contact our care team."
      );
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/portal/schedule-link/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data?.ok) {
          setStep("link_error");
          setLinkErrorMsg(
            data?.error ||
              "We couldn't open this scheduling link. Please contact our care team for a new one."
          );
          return;
        }
        const s = data as SessionData;
        setSession(s);
        if (s.clinic?.departmentId) setDepartmentId(s.clinic.departmentId);
        setStep(s.mode === "reschedule" ? "reschedule_choice" : "reason");
      } catch {
        if (cancelled) return;
        setStep("link_error");
        setLinkErrorMsg(
          "We're having trouble connecting. Please try again in a moment."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ── Fetch slots when entering the time step ─────────────────────────────────
  const fetchSlots = useCallback(async () => {
    if (!token || !departmentId || !appointmentTypeId) return;
    setSlotsLoading(true);
    setSlotsError(null);
    setSelectedSlot(null);
    try {
      const start = new Date();
      const end = new Date();
      end.setDate(end.getDate() + 30);
      const res = await fetch("/api/portal/schedule-link/available", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          departmentId,
          appointmenttypeid: appointmentTypeId,
          startdate: mmddyyyy(start),
          enddate: mmddyyyy(end),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setSlotsError(data?.error || "Could not load available times.");
        setSlots([]);
        return;
      }
      setSlots(Array.isArray(data.appointments) ? data.appointments : []);
    } catch {
      setSlotsError("Could not load available times. Please try again.");
      setSlots([]);
    } finally {
      setSlotsLoading(false);
    }
  }, [token, departmentId, appointmentTypeId]);

  useEffect(() => {
    if (step === "time") void fetchSlots();
  }, [step, fetchSlots]);

  // ── Reason selection → appointment type ─────────────────────────────────────
  const chooseReason = useCallback(
    (cat: PortalCategory, mod: VisitModality) => {
      const type = getAppointmentType(cat, mod);
      setCategory(cat);
      setModality(mod);
      setRebookSameVisit(false);
      if (type) {
        setAppointmentTypeId(type.appointmentTypeId);
        setAppointmentTypeName(type.displayName);
      }
    },
    []
  );

  // ── Rebook the cancelled visit as-is ────────────────────────────────────────
  const startSameVisitRebook = useCallback(() => {
    const c = session?.recentCancellation;
    if (!c) return;
    setRebookSameVisit(true);
    if (c.appointmentTypeId) {
      setAppointmentTypeId(Number(c.appointmentTypeId));
    }
    setAppointmentTypeName(c.appointmentType || "Your visit");
    if (c.departmentId) setDepartmentId(c.departmentId);
    setStep("time");
  }, [session]);

  // ── Book the selected slot ──────────────────────────────────────────────────
  const confirmBooking = useCallback(async () => {
    if (!token || !selectedSlot) return;
    setBooking(true);
    setBookError(null);
    try {
      const res = await fetch("/api/portal/schedule-link/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          appointmentId: Number(selectedSlot.appointmentid),
          appointmenttypeid: appointmentTypeId ?? undefined,
          departmentId: departmentId || selectedSlot.departmentid,
          providerId: selectedSlot.providerid,
          locationName:
            session?.clinics.find((c) => c.departmentId === departmentId)?.name ||
            session?.clinic?.name,
          providerName: slotProvider(selectedSlot),
          appointmentTypeName,
          duration: selectedSlot.duration,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        if (data?.code === "ATHENA_SLOT_TAKEN") {
          setBookError(
            "That time was just taken. Please choose another time below."
          );
          setStep("time");
          void fetchSlots();
          return;
        }
        if (
          data?.code === "SCHEDULE_LINK_USED" ||
          data?.code === "SCHEDULE_LINK_EXPIRED"
        ) {
          setStep("link_error");
          setLinkErrorMsg(
            data?.error ||
              "This link has already been used. Please contact our care team."
          );
          return;
        }
        setBookError(data?.error || "We couldn't book that time. Please try again.");
        return;
      }
      setStep("success");
    } catch {
      setBookError("We're having trouble connecting. Please try again.");
    } finally {
      setBooking(false);
    }
  }, [
    token,
    selectedSlot,
    appointmentTypeId,
    departmentId,
    appointmentTypeName,
    session,
    fetchSlots,
  ]);

  const grouped = useMemo(() => groupByDate(slots), [slots]);
  const clinicName = useMemo(
    () =>
      session?.clinics.find((c) => c.departmentId === departmentId)?.name ||
      session?.clinic?.name ||
      "Your clinic",
    [session, departmentId]
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 sm:py-10">
      <div aria-live="polite" className="sr-only">
        {step === "success" ? "Your appointment is booked." : ""}
        {bookError ?? ""}
        {slotsError ?? ""}
      </div>

      <header className="mb-6 text-center">
        <div className="mb-3 flex justify-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CalendarCheck className="h-6 w-6" />
          </span>
        </div>
        <h1 className="font-serif text-2xl sm:text-3xl font-medium">
          {step === "success"
            ? "You're all set"
            : session?.patient.firstName
            ? `Hi ${session.patient.firstName}, let's find a time`
            : "Schedule your visit"}
        </h1>
      </header>

      {step === "loading" && <LoadingState />}

      {step === "link_error" && (
        <ErrorCard message={linkErrorMsg ?? "This link is no longer valid."} />
      )}

      {session && step === "reschedule_choice" && (
        <RescheduleChoice
          cancellation={session.recentCancellation!}
          onSameVisit={startSameVisitRebook}
          onSymptomsChanged={() => setStep("reason")}
        />
      )}

      {session && step === "reason" && (
        <ReasonStep
          session={session}
          modality={modality}
          category={category}
          departmentId={departmentId}
          onModality={setModality}
          onChooseReason={chooseReason}
          onDepartment={setDepartmentId}
          onBack={
            session.mode === "reschedule"
              ? () => setStep("reschedule_choice")
              : undefined
          }
          onContinue={() => setStep("time")}
        />
      )}

      {session && step === "time" && (
        <TimeStep
          clinicName={clinicName}
          appointmentTypeName={appointmentTypeName}
          loading={slotsLoading}
          error={slotsError}
          grouped={grouped}
          selectedSlot={selectedSlot}
          onSelect={setSelectedSlot}
          onRetry={fetchSlots}
          onBack={() =>
            setStep(rebookSameVisit ? "reschedule_choice" : "reason")
          }
          onContinue={() => setStep("confirm")}
        />
      )}

      {session && step === "confirm" && selectedSlot && (
        <ConfirmStep
          session={session}
          clinicName={clinicName}
          appointmentTypeName={appointmentTypeName}
          slot={selectedSlot}
          booking={booking}
          error={bookError}
          onBack={() => setStep("time")}
          onConfirm={confirmBooking}
        />
      )}

      {session && step === "success" && selectedSlot && (
        <SuccessStep
          session={session}
          clinicName={clinicName}
          appointmentTypeName={appointmentTypeName}
          slot={selectedSlot}
        />
      )}

      {/* Tier nudge + follow-up suggestions while scheduling. */}
      {session &&
        (step === "reason" || step === "time" || step === "confirm") && (
          <div className="mt-6 space-y-4">
            {session.tier && <TierNudge message={session.tier.message} />}
            <FollowUpSuggestions
              followUps={session.followUps}
              onPickAwv={() => {
                chooseReason("awv", modality);
                setStep("time");
              }}
              onPickMddo={() => {
                chooseReason("routine", modality);
                setStep("time");
              }}
            />
          </div>
        )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
        <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
        <p className="text-lg text-foreground">{message}</p>
        <p className="text-base text-muted-foreground">
          You can call us at{" "}
          <a href="tel:18558005900" className="font-medium text-primary underline">
            1-855-800-5900
          </a>{" "}
          and we&apos;ll help you book.
        </p>
      </CardContent>
    </Card>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onBack}
      className="mb-2 h-12 gap-2 px-2 text-base text-muted-foreground"
    >
      <ChevronLeft className="h-5 w-5" />
      Back
    </Button>
  );
}

function RescheduleChoice({
  cancellation,
  onSameVisit,
  onSymptomsChanged,
}: {
  cancellation: RecentCancellation;
  onSameVisit: () => void;
  onSymptomsChanged: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card className="bg-muted/40">
        <CardContent className="py-5">
          <p className="text-base text-muted-foreground">
            We see you recently cancelled a visit:
          </p>
          <p className="mt-1 text-lg font-medium">
            {cancellation.appointmentType || "Your visit"}
            {cancellation.date ? ` on ${prettyDate(cancellation.date)}` : ""}
          </p>
        </CardContent>
      </Card>

      <p className="px-1 text-lg">Would you like to rebook the same visit?</p>

      <BigChoiceButton
        title="Yes, rebook the same visit"
        subtitle="We'll find a new time for the same type of visit"
        icon={CalendarCheck}
        onClick={onSameVisit}
      />
      <BigChoiceButton
        title="My symptoms have changed"
        subtitle="Tell us what's going on and we'll match the right visit"
        icon={HeartPulse}
        onClick={onSymptomsChanged}
      />
    </div>
  );
}

function BigChoiceButton({
  title,
  subtitle,
  icon: Icon,
  onClick,
  selected,
}: {
  title: string;
  subtitle: string;
  icon: typeof Stethoscope;
  onClick: () => void;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center gap-4 rounded-2xl border-2 p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/50 hover:bg-muted/40"
      }`}
    >
      <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="h-6 w-6" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-medium">{title}</span>
        <span className="block text-base text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );
}

function ReasonStep({
  session,
  modality,
  category,
  departmentId,
  onModality,
  onChooseReason,
  onDepartment,
  onBack,
  onContinue,
}: {
  session: SessionData;
  modality: VisitModality;
  category: PortalCategory | null;
  departmentId: string;
  onModality: (m: VisitModality) => void;
  onChooseReason: (c: PortalCategory, m: VisitModality) => void;
  onDepartment: (id: string) => void;
  onBack?: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-5">
      {onBack && <BackButton onBack={onBack} />}

      <fieldset>
        <legend className="mb-2 text-lg font-medium">How would you like to be seen?</legend>
        <div className="grid grid-cols-2 gap-3">
          <ToggleChip
            label="In person"
            icon={Building2}
            selected={modality === "in_person"}
            onClick={() => onModality("in_person")}
          />
          <ToggleChip
            label="Video visit"
            icon={Video}
            selected={modality === "telehealth"}
            onClick={() => onModality("telehealth")}
          />
        </div>
      </fieldset>

      {session.clinics.length > 1 && (
        <div>
          <label className="mb-2 block text-lg font-medium" htmlFor="clinic-select">
            Which clinic?
          </label>
          <Select value={departmentId} onValueChange={onDepartment}>
            <SelectTrigger id="clinic-select" className="h-14 text-base">
              <SelectValue placeholder="Choose a clinic" />
            </SelectTrigger>
            <SelectContent>
              {session.clinics.map((c) => (
                <SelectItem key={c.departmentId} value={c.departmentId} className="text-base">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <fieldset>
        <legend className="mb-2 text-lg font-medium">What&apos;s the visit for?</legend>
        <div className="space-y-3">
          {REASON_OPTIONS.map((opt) => (
            <BigChoiceButton
              key={opt.category}
              title={opt.label}
              subtitle={opt.description}
              icon={opt.icon}
              selected={category === opt.category}
              onClick={() => onChooseReason(opt.category, modality)}
            />
          ))}
        </div>
      </fieldset>

      <Button
        type="button"
        size="lg"
        className="h-14 w-full text-lg"
        disabled={!category || !departmentId}
        onClick={onContinue}
      >
        See available times
      </Button>
    </div>
  );
}

function ToggleChip({
  label,
  icon: Icon,
  selected,
  onClick,
}: {
  label: string;
  icon: typeof Building2;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex h-20 flex-col items-center justify-center gap-1 rounded-2xl border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        selected
          ? "border-primary bg-primary/5 text-primary"
          : "border-border bg-card text-foreground hover:border-primary/50"
      }`}
    >
      <Icon className="h-6 w-6" aria-hidden />
      <span className="text-base font-medium">{label}</span>
    </button>
  );
}

function TimeStep({
  clinicName,
  appointmentTypeName,
  loading,
  error,
  grouped,
  selectedSlot,
  onSelect,
  onRetry,
  onBack,
  onContinue,
}: {
  clinicName: string;
  appointmentTypeName: string;
  loading: boolean;
  error: string | null;
  grouped: Array<{ date: string; slots: Slot[] }>;
  selectedSlot: Slot | null;
  onSelect: (s: Slot) => void;
  onRetry: () => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-5">
      <BackButton onBack={onBack} />

      <Card className="bg-muted/40">
        <CardContent className="py-4">
          <p className="text-base text-muted-foreground">
            {appointmentTypeName || "Your visit"} at {clinicName}
          </p>
        </CardContent>
      </Card>

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      )}

      {!loading && error && (
        <Card className="border-destructive/30">
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-base">{error}</p>
            <Button type="button" variant="outline" className="h-12" onClick={onRetry}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && grouped.length === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-base text-muted-foreground">
            We couldn&apos;t find open times in the next 30 days. Please call us at{" "}
            <a href="tel:18558005900" className="font-medium text-primary underline">
              1-855-800-5900
            </a>
            .
          </CardContent>
        </Card>
      )}

      {!loading &&
        !error &&
        grouped.map((group) => (
          <div key={group.date}>
            <h2 className="mb-2 text-lg font-medium">{prettyDate(group.date)}</h2>
            <div className="grid grid-cols-1 gap-2">
              {group.slots.map((s) => {
                const isSel =
                  selectedSlot?.appointmentid === s.appointmentid &&
                  selectedSlot?.starttime === s.starttime;
                return (
                  <button
                    key={`${s.appointmentid}-${s.starttime}`}
                    type="button"
                    onClick={() => onSelect(s)}
                    aria-pressed={isSel}
                    className={`flex min-h-14 items-center justify-between rounded-xl border-2 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      isSel
                        ? "border-primary bg-primary/5"
                        : "border-border bg-card hover:border-primary/50"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-lg font-medium">
                      <Clock className="h-5 w-5 text-primary" aria-hidden />
                      {prettyTime(s.starttime)}
                    </span>
                    <span className="text-base text-muted-foreground">
                      {slotProvider(s)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      <Button
        type="button"
        size="lg"
        className="h-14 w-full text-lg"
        disabled={!selectedSlot}
        onClick={onContinue}
      >
        Continue
      </Button>
    </div>
  );
}

function ConfirmStep({
  session,
  clinicName,
  appointmentTypeName,
  slot,
  booking,
  error,
  onBack,
  onConfirm,
}: {
  session: SessionData;
  clinicName: string;
  appointmentTypeName: string;
  slot: Slot;
  booking: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-5">
      <BackButton onBack={onBack} />

      <Card>
        <CardContent className="space-y-4 py-6">
          <h2 className="text-xl font-medium">Please confirm your visit</h2>
          <SummaryRow label="Visit" value={appointmentTypeName || "Your visit"} />
          <SummaryRow label="When" value={`${prettyDate(slot.date)} at ${prettyTime(slot.starttime)}`} />
          <SummaryRow label="Where" value={clinicName} />
          <SummaryRow label="Provider" value={slotProvider(slot)} />
        </CardContent>
      </Card>

      {error && (
        <p className="rounded-xl bg-destructive/10 px-4 py-3 text-base text-destructive">
          {error}
        </p>
      )}

      <Button
        type="button"
        size="lg"
        className="h-14 w-full text-lg"
        disabled={booking}
        onClick={onConfirm}
      >
        {booking ? (
          <>
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Booking…
          </>
        ) : (
          "Confirm appointment"
        )}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Patient: {session.patient.firstName ?? "you"}
      </p>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col border-b pb-3 last:border-0 last:pb-0">
      <span className="text-sm uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-lg">{value}</span>
    </div>
  );
}

function SuccessStep({
  session,
  clinicName,
  appointmentTypeName,
  slot,
}: {
  session: SessionData;
  clinicName: string;
  appointmentTypeName: string;
  slot: Slot;
}) {
  return (
    <div className="space-y-5">
      <Card className="border-primary/30">
        <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
          <CheckCircle2 className="h-14 w-14 text-primary" aria-hidden />
          <h2 className="text-2xl font-medium">Your visit is booked</h2>
          <p className="text-lg">
            {appointmentTypeName || "Your visit"}
            <br />
            {prettyDate(slot.date)} at {prettyTime(slot.starttime)}
            <br />
            {clinicName}
          </p>
          <p className="text-base text-muted-foreground">
            We&apos;ll send you a reminder before your visit. You can close this page.
          </p>
        </CardContent>
      </Card>

      {(session.followUps.awv || session.followUps.mddo) && (
        <Card className="bg-muted/40">
          <CardContent className="py-5">
            <p className="text-base text-muted-foreground">
              When you&apos;re ready, your care team also recommends:
            </p>
            <ul className="mt-2 space-y-1 text-lg">
              {session.followUps.awv && <li>• Annual Wellness Visit</li>}
              {session.followUps.mddo && <li>• A visit with your doctor (MD/DO)</li>}
            </ul>
            <p className="mt-2 text-base text-muted-foreground">
              Call us at{" "}
              <a href="tel:18558005900" className="font-medium text-primary underline">
                1-855-800-5900
              </a>{" "}
              to add one of these.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TierNudge({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-4">
      <HeartPulse className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      <p className="text-base text-foreground">{message}</p>
    </div>
  );
}

function FollowUpSuggestions({
  followUps,
  onPickAwv,
  onPickMddo,
}: {
  followUps: { mddo: boolean; awv: boolean };
  onPickAwv: () => void;
  onPickMddo: () => void;
}) {
  if (!followUps.awv && !followUps.mddo) return null;
  return (
    <div className="rounded-2xl border border-dashed border-border p-4">
      <p className="mb-3 text-base font-medium text-muted-foreground">
        You may also be due for:
      </p>
      <div className="space-y-3">
        {followUps.awv && (
          <BigChoiceButton
            title="Annual Wellness Visit"
            subtitle="Your yearly Medicare wellness visit"
            icon={CalendarCheck}
            onClick={onPickAwv}
          />
        )}
        {followUps.mddo && (
          <BigChoiceButton
            title="Visit with your doctor (MD/DO)"
            subtitle="A check-in with your physician"
            icon={Stethoscope}
            onClick={onPickMddo}
          />
        )}
      </div>
    </div>
  );
}
