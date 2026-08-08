import { describe, expect, it } from "vitest";
import {
  findRecentCancellation,
  parseAthenaDate,
  resolveScheduleMode,
} from "./reschedule";
import type { AthenaAppointment } from "@/lib/athena/client";

function appt(partial: Partial<AthenaAppointment>): AthenaAppointment {
  return {
    appointmentid: "1",
    appointmentstatus: "f",
    appointmenttype: "Routine",
    appointmenttypeid: "49",
    date: "01/01/2026",
    starttime: "09:00",
    duration: 40,
    departmentid: "1",
    providerid: "10",
    ...partial,
  } as AthenaAppointment;
}

describe("parseAthenaDate", () => {
  it("parses MM/DD/YYYY", () => {
    const d = parseAthenaDate("06/09/2026");
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.getUTCMonth()).toBe(5); // June (0-based)
    expect(d?.getUTCDate()).toBe(9);
  });

  it("returns null on garbage", () => {
    expect(parseAthenaDate("not-a-date")).toBeNull();
    expect(parseAthenaDate(null)).toBeNull();
    expect(parseAthenaDate(undefined)).toBeNull();
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    // Date.UTC would normalize 02/31 into early March; we must reject it.
    expect(parseAthenaDate("02/31/2026")).toBeNull();
    expect(parseAthenaDate("13/01/2026")).toBeNull();
    expect(parseAthenaDate("00/10/2026")).toBeNull();
    expect(parseAthenaDate("06/00/2026")).toBeNull();
    expect(parseAthenaDate("04/31/2026")).toBeNull();
  });

  it("accepts a real leap day", () => {
    expect(parseAthenaDate("02/29/2024")).not.toBeNull();
    expect(parseAthenaDate("02/29/2026")).toBeNull(); // 2026 is not a leap year
  });
});

describe("findRecentCancellation", () => {
  const now = new Date(Date.UTC(2026, 5, 9)); // 06/09/2026

  it("returns null when there are no cancellations", () => {
    const appts = [appt({ appointmentstatus: "f" }), appt({ appointmentstatus: "3" })];
    expect(findRecentCancellation(appts, now)).toBeNull();
  });

  it("finds a cancellation within the 30-day window", () => {
    const appts = [
      appt({ appointmentid: "99", appointmentstatus: "x", date: "05/25/2026" }),
    ];
    const c = findRecentCancellation(appts, now);
    expect(c).not.toBeNull();
    expect(c?.appointmentId).toBe("99");
  });

  it("ignores cancellations older than the window", () => {
    const appts = [
      appt({ appointmentstatus: "x", date: "01/01/2026" }), // > 30 days ago
    ];
    expect(findRecentCancellation(appts, now)).toBeNull();
  });

  it("ignores future-dated rows", () => {
    const appts = [appt({ appointmentstatus: "x", date: "07/01/2026" })];
    expect(findRecentCancellation(appts, now)).toBeNull();
  });

  it("returns the most recent cancellation when several qualify", () => {
    const appts = [
      appt({ appointmentid: "a", appointmentstatus: "x", date: "05/20/2026" }),
      appt({ appointmentid: "b", appointmentstatus: "x", date: "06/05/2026" }),
    ];
    expect(findRecentCancellation(appts, now)?.appointmentId).toBe("b");
  });

  it("respects the window boundary (exactly 30 days)", () => {
    const appts = [
      appt({ appointmentid: "edge", appointmentstatus: "x", date: "05/10/2026" }), // 30 days
    ];
    expect(findRecentCancellation(appts, now)?.appointmentId).toBe("edge");
  });

  it("extracts provider name from the cancelled row", () => {
    const appts = [
      appt({
        appointmentstatus: "x",
        date: "06/01/2026",
        providerfirstname: "Ada",
        providerlastname: "Lovelace",
      }),
    ];
    expect(findRecentCancellation(appts, now)?.providerName).toBe("Ada Lovelace");
  });
});

describe("resolveScheduleMode", () => {
  it("returns reschedule when a cancellation exists", () => {
    expect(
      resolveScheduleMode({
        appointmentId: "1",
        date: "06/01/2026",
        appointmentTypeId: "49",
        appointmentType: "Routine",
        providerId: "10",
        providerName: "Ada Lovelace",
        departmentId: "1",
      })
    ).toBe("reschedule");
  });

  it("returns schedule when there is no cancellation", () => {
    expect(resolveScheduleMode(null)).toBe("schedule");
  });
});
