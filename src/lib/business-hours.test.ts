import { describe, expect, it } from "vitest";
import { formatChicagoDateLabel, getChicagoBusinessWindow } from "./business-hours";

describe("getChicagoBusinessWindow", () => {
  it("is open during weekday business hours", () => {
    const now = new Date("2026-04-27T15:00:00.000Z"); // Monday 10:00 AM CDT
    const window = getChicagoBusinessWindow(now);

    expect(window.isOpenNow).toBe(true);
  });

  it("returns Monday for Saturday requests", () => {
    const now = new Date("2026-04-25T15:00:00.000Z"); // Saturday 10:00 AM CDT
    const window = getChicagoBusinessWindow(now);

    expect(window.isOpenNow).toBe(false);
    expect(window.nextBusinessDateLabel).toBe("Monday, April 27");
  });

  it("skips observed Independence Day holiday", () => {
    const now = new Date("2026-07-02T23:30:00.000Z"); // Thursday 6:30 PM CDT
    const window = getChicagoBusinessWindow(now);

    expect(window.isOpenNow).toBe(false);
    expect(window.nextBusinessDateLabel).toBe("Monday, July 6");
  });

  it("skips Thanksgiving Day", () => {
    const now = new Date("2026-11-25T23:30:00.000Z"); // Wednesday 5:30 PM CST
    const window = getChicagoBusinessWindow(now);

    expect(window.isOpenNow).toBe(false);
    expect(window.nextBusinessDateLabel).toBe("Friday, November 27");
  });
});

describe("formatChicagoDateLabel", () => {
  it("formats a date for patient-facing copy", () => {
    const date = new Date("2026-04-27T12:00:00.000Z");
    expect(formatChicagoDateLabel(date)).toBe("Monday, April 27");
  });
});

