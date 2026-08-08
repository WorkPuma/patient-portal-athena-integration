"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Calendar,
  CheckCircle2,
  Info,
  MapPin,
  Mail,
  User,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  clearRegistration,
  loadRegistration,
  registerFetch,
} from "@/components/portal/registration/registration-client";
import { getClientPortalFeatureFlags } from "@/lib/portal/feature-flags";

interface BookedSlot {
  date: string;
  starttime: string;
  providerfirstname?: string;
  providerlastname?: string;
  /** Set by the new ZocDoc-style InitialVisitScheduler. Falls back to
   * provider first/last when the patient came through an older deploy. */
  providerName?: string;
  locationName?: string;
  locationShortName?: string;
  locationAddress?: string;
}

/**
 * Sample slot used when navigating directly to the confirmation URL
 * without going through the booking flow (no session data). This lets
 * the team preview the full UI for visual sign-off.
 */
const PREVIEW_SLOT: BookedSlot = {
  date: "05/14/2026",
  starttime: "10:00",
  providerName: "Dr. Sarah Johnson",
  locationName: "Highland Park Clinic",
  locationAddress: "2004 Ford Pkwy, St. Paul, MN 55116",
};

/* ────────────────────────── helpers ────────────────────────── */

function formatStartTime(starttime: string): string {
  const [hStr, m] = starttime.split(":");
  const h = parseInt(hStr, 10);
  if (!Number.isFinite(h)) return starttime;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m} ${ampm}`;
}

function formatDisplayDate(dateStr: string): string {
  const [month, day, year] = dateStr.split("/");
  if (!month || !day || !year) return dateStr;
  const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function parseDateParts(dateStr: string): { month: number; day: number; year: number } | null {
  const [m, d, y] = dateStr.split("/");
  if (!m || !d || !y) return null;
  return { month: parseInt(m, 10), day: parseInt(d, 10), year: parseInt(y, 10) };
}

function parseTimeParts(starttime: string): { hour: number; minute: number } | null {
  const [h, m] = starttime.split(":");
  if (!h || !m) return null;
  return { hour: parseInt(h, 10), minute: parseInt(m, 10) };
}

/** Build a Google Maps directions URL from a location address string. */
function googleMapsUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

/** Generate and download an .ics calendar file for the appointment. */
function downloadIcs(slot: BookedSlot) {
  const dp = parseDateParts(slot.date);
  const tp = parseTimeParts(slot.starttime);
  if (!dp || !tp) return;

  const pad = (n: number) => String(n).padStart(2, "0");

  // Build start/end in local time — ICS DTSTART without trailing Z is
  // treated as "floating" local time, which is correct here because
  // we don't know the user's timezone for certain.
  const start = `${dp.year}${pad(dp.month)}${pad(dp.day)}T${pad(tp.hour)}${pad(tp.minute)}00`;
  // 90-minute appointment
  const endHour = tp.hour + Math.floor((tp.minute + 90) / 60);
  const endMin = (tp.minute + 90) % 60;
  const end = `${dp.year}${pad(dp.month)}${pad(dp.day)}T${pad(endHour)}${pad(endMin)}00`;

  const provider = slot.providerName
    || [slot.providerfirstname, slot.providerlastname].filter(Boolean).join(" ")
    || "";
  const location = [slot.locationName, slot.locationAddress].filter(Boolean).join(", ");
  const summary = provider
    ? `Herself Health – Initial Visit with ${provider}`
    : "Herself Health – Initial Visit";

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Herself Health//Patient Portal//EN",
    "BEGIN:VEVENT",
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location}`,
    `DESCRIPTION:Your initial visit with Herself Health. Please arrive 10 minutes early.`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "patient-portal-appointment.ics";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ─────────────────────── session helpers ───────────────────── */

function readBookedSlot(): BookedSlot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem("hh_reg_booked_slot");
    return raw ? (JSON.parse(raw) as BookedSlot) : null;
  } catch {
    return null;
  }
}

function initialAutoSendStatus():
  | "idle"
  | "sending"
  | "sent"
  | "skipped"
  | "error" {
  if (typeof window === "undefined") return "idle";
  // Skip the claim-link email when auth-UI is off — there's no account
  // for the patient to set up, so emailing them a magic link is confusing.
  if (!getClientPortalFeatureFlags().authUi) return "skipped";
  return loadRegistration() ? "sending" : "skipped";
}

/* ────────────────────────── component ─────────────────────── */

export function RegistrationConfirmation() {
  // Hydrate slot + initial status from sessionStorage in the useState
  // initializer so we don't trip the react-hooks/set-state-in-effect lint
  // rule (cascading renders inside useEffect).
  const realSlot = readBookedSlot();
  const isPreview = !realSlot;
  const [slot] = useState<BookedSlot | null>(realSlot ?? PREVIEW_SLOT);
  const [autoSendStatus, setAutoSendStatus] = useState(initialAutoSendStatus);
  const authUiEnabled = getClientPortalFeatureFlags().authUi;

  useEffect(() => {
    if (autoSendStatus !== "sending") return;
    let cancelled = false;
    (async () => {
      const result = await registerFetch<{ sent: { email?: boolean } }>(
        "/api/portal/register/claim/send",
        {
          method: "POST",
          body: JSON.stringify({ channels: ["email"] }),
        }
      );
      if (cancelled) return;
      if (result.ok && result.data?.sent?.email) {
        setAutoSendStatus("sent");
      } else {
        setAutoSendStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoSendStatus]);

  const providerDisplay =
    slot?.providerName ||
    (slot?.providerfirstname || slot?.providerlastname
      ? `Dr. ${slot?.providerfirstname ?? ""} ${slot?.providerlastname ?? ""}`.trim()
      : null);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        {/* ── Confirmation Card ─────────────────────────────── */}
        <Card className="overflow-hidden">
          <CardContent className="pt-10 pb-8 px-6 sm:px-10">
            {/* Preview banner — visible only when no real booking data exists */}
            {isPreview && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 mb-6 text-left">
                <Info className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">
                    Design Preview
                  </p>
                  <p className="text-sm text-amber-700 mt-0.5">
                    You&apos;re viewing this page directly. The data below is
                    sample content. After a real booking, the patient&apos;s
                    actual appointment details will appear here.
                  </p>
                </div>
              </div>
            )}

            {/* Header */}
            <div className="text-center mb-8">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-pink-100">
                <CheckCircle2 className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl sm:text-3xl font-serif font-medium text-foreground">
                Appointment Confirmed
              </h1>
            </div>

            {/* ── Date/Time + Location cards ───────────────── */}
            {slot && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                {/* Date & Time */}
                <div className="rounded-xl border border-border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                      Date &amp; Time
                    </span>
                  </div>
                  <p className="font-medium text-foreground text-sm">
                    {formatDisplayDate(slot.date)}
                  </p>
                  <p className="text-sm text-primary mt-0.5">
                    at {formatStartTime(slot.starttime)}
                  </p>
                </div>

                {/* Location */}
                <div className="rounded-xl border border-border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                      Location
                    </span>
                  </div>
                  <p className="text-xs font-semibold text-muted-foreground">
                    Herself Health
                  </p>
                  <p className="font-medium text-foreground text-sm">
                    {slot.locationName ?? "Clinic"}
                  </p>
                  {slot.locationAddress && (
                    <>
                      <p className="text-sm text-foreground/80 mt-1">
                        {slot.locationAddress}
                      </p>
                      <a
                        href={googleMapsUrl(slot.locationAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline mt-1 inline-block"
                      >
                        Get Directions
                      </a>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── Provider ─────────────────────────────────── */}
            {providerDisplay && (
              <div className="flex items-center gap-3 mb-6 px-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <User className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                    Provider
                  </p>
                  <p className="text-sm font-medium text-foreground">
                    {providerDisplay}
                  </p>
                </div>
              </div>
            )}

            {/* ── Info panel ───────────────────────────────── */}
            <div className="rounded-xl border-l-4 border-l-primary/30 bg-muted/40 p-5 mb-8 space-y-4 text-sm text-foreground/90">
              <p>
                Thank you for scheduling your first visit with Herself Health!
                This appointment will take ~90 minutes and is focused on
                establishing care with your new provider.
              </p>
              <p>
                Please note that this first appointment is not your annual
                wellness visit. Your initial visit is an office visit and will be
                billed as such. Any copay printed on your insurance card will be
                paid by you at the time of your visit. Your insurance may process
                your claim and leave added patient responsibility which we will
                then bill you for later.
              </p>
              <p className="italic text-foreground/70">
                We recommend that you call your insurance for details of your
                plan coverage.
              </p>
            </div>

            {/* ── Email alerts ─────────────────────────────── */}
            {authUiEnabled &&
              (autoSendStatus === "sent" || autoSendStatus === "sending") && (
                <Alert className="mb-4 text-left">
                  <Mail className="h-4 w-4" />
                  <AlertTitle>
                    {autoSendStatus === "sending"
                      ? "Sending your account-setup link..."
                      : "Check your email"}
                  </AlertTitle>
                  <AlertDescription>
                    {autoSendStatus === "sending"
                      ? "We're emailing you a secure link so you can manage this visit online."
                      : "We sent you a secure link to set up an account so you can manage this visit, message your care team, and view your membership."}
                  </AlertDescription>
                </Alert>
              )}

            {authUiEnabled && autoSendStatus === "error" && (
              <Alert variant="destructive" className="mb-4 text-left">
                <AlertTitle>Couldn&apos;t send your link automatically</AlertTitle>
                <AlertDescription>
                  You can still create your account from the button below.
                </AlertDescription>
              </Alert>
            )}

            {/* ── Actions ──────────────────────────────────── */}
            {authUiEnabled ? (
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button
                  size="lg"
                  className="rounded-xl"
                  asChild
                  onClick={() => {
                    // Don't clear regToken here — user may use it to claim now via
                    // the next button. We clear it only after Clerk sign-up succeeds.
                  }}
                >
                  <Link href="/register/create-account">
                    Create my account
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Link>
                </Button>
                {slot && (
                  <Button
                    size="lg"
                    variant="outline"
                    className="rounded-xl border-primary text-primary hover:bg-primary/5"
                    onClick={() => downloadIcs(slot)}
                  >
                    Add to Calendar
                  </Button>
                )}
                <Button
                  size="lg"
                  variant="outline"
                  className="rounded-xl"
                  asChild
                  onClick={() => clearRegistration()}
                >
                  <Link href="/login">Done</Link>
                </Button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                {slot && (
                  <Button
                    size="lg"
                    className="rounded-xl"
                    onClick={() => downloadIcs(slot)}
                  >
                    Add to Calendar
                  </Button>
                )}
                <Button
                  size="lg"
                  variant="outline"
                  className="rounded-xl border-foreground/30"
                  asChild
                  onClick={() => clearRegistration()}
                >
                  <Link href="/">Done</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Footer hint ──────────────────────────────────── */}
        {authUiEnabled ? (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            You don&apos;t need an account to come to your visit. Setting one up
            just makes it easier to manage appointments, billing, and messages.
          </p>
        ) : (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            We&apos;ll text you a reminder before your visit. If anything
            changes, call the clinic and we&apos;ll take care of it.
          </p>
        )}
      </div>
    </div>
  );
}
