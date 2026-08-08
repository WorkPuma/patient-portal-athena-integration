/**
 * Reschedule-vs-Schedule branching for the standalone link.
 *
 * Product rule: if a patient cancelled a visit within the last 30 days we
 * treat the link as a RESCHEDULE — we ask whether they want the same visit
 * back or whether their symptoms have changed. Otherwise it's a fresh
 * SCHEDULE that starts from their clinic + PCP.
 *
 * Athena returns `appointmentstatus` "x" for a cancelled appointment and
 * `date` as `MM/DD/YYYY`. This module is pure (no Athena/network) so it can
 * be unit-tested against fixture appointment rows.
 */

import type { AthenaAppointment } from "@/lib/athena/client";

/** Trailing window (days) for post-cancellation reschedule mode. */
export const RESCHEDULE_WINDOW_DAYS = 30;

/** Athena status code for a cancelled appointment. */
const CANCELLED_STATUS = "x";

/** Most recent cancelled appointment within the reschedule window. */
export interface RecentCancellation {
  appointmentId: string;
  /** Original cancelled date (MM/DD/YYYY as Athena returns it). */
  date: string;
  appointmentTypeId: string | null;
  appointmentType: string | null;
  providerId: string | null;
  providerName: string | null;
  departmentId: string | null;
}

/** Parse Athena `MM/DD/YYYY` into a UTC Date, or null when unparseable. */
export function parseAthenaDate(date: string | null | undefined): Date | null {
  if (!date) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  // Date.UTC silently normalizes overflow (e.g. 02/31 -> Mar 03), so reject
  // any value the constructor rolled into a different calendar date.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/** Inclusive day-difference between two dates (UTC). */
function daysBetween(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Find the most recent appointment the patient cancelled within
 * `windowDays` of `now`. Returns null when there is none (→ schedule flow).
 */
export function findRecentCancellation(
  appointments: AthenaAppointment[],
  now: Date = new Date(),
  windowDays: number = RESCHEDULE_WINDOW_DAYS
): RecentCancellation | null {
  let best: { cancellation: RecentCancellation; when: Date } | null = null;

  for (const appt of appointments) {
    const status = String(appt.appointmentstatus ?? "").trim().toLowerCase();
    if (status !== CANCELLED_STATUS) continue;

    const when = parseAthenaDate(appt.date);
    if (!when) continue;

    const age = daysBetween(now, when);
    // Within the trailing window (0..windowDays). Skip future-dated rows
    // and anything older than the window.
    if (age < 0 || age > windowDays) continue;

    if (!best || when.getTime() > best.when.getTime()) {
      best = {
        when,
        cancellation: {
          appointmentId: String(appt.appointmentid ?? ""),
          date: String(appt.date ?? ""),
          appointmentTypeId: appt.appointmenttypeid
            ? String(appt.appointmenttypeid)
            : null,
          appointmentType: appt.appointmenttype
            ? String(appt.appointmenttype)
            : null,
          providerId: appt.providerid ? String(appt.providerid) : null,
          providerName:
            [appt.providerfirstname, appt.providerlastname]
              .filter(Boolean)
              .join(" ")
              .trim() || null,
          departmentId: appt.departmentid ? String(appt.departmentid) : null,
        },
      };
    }
  }

  return best?.cancellation ?? null;
}

/** Standalone link mode: fresh schedule vs post-cancellation reschedule. */
export type ScheduleMode = "reschedule" | "schedule";

/** Resolve the link mode from a recent-cancellation lookup. */
export function resolveScheduleMode(
  cancellation: RecentCancellation | null
): ScheduleMode {
  return cancellation ? "reschedule" : "schedule";
}
