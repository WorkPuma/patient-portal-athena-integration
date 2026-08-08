import { describe, expect, it } from "vitest";
import {
  ASSISTANT_NAME,
  INITIAL_MESSAGE,
  INTENT_OPTIONS,
  isValidHandoffEmail,
  isValidHandoffPhone,
  toUserSummary,
  validateHandoff,
} from "./portal-chat-widget-helpers";

describe("portal chat widget helpers", () => {
  it("introduces Dot in the initial message", () => {
    expect(INITIAL_MESSAGE).toContain(ASSISTANT_NAME);
    expect(INITIAL_MESSAGE).toMatch(/talk to a person/i);
  });

  it("ships a Talk-to-a-person intent chip", () => {
    expect(INTENT_OPTIONS.find((o) => o.id === "human")).toBeDefined();
  });

  it("validates email format for handoff intake", () => {
    expect(isValidHandoffEmail("jane@example.com")).toBe(true);
    expect(isValidHandoffEmail("not-an-email")).toBe(false);
  });

  it("validates US-style phone numbers for callback", () => {
    expect(isValidHandoffPhone("612-555-0100")).toBe(true);
    expect(isValidHandoffPhone("(612) 555 0100")).toBe(true);
    expect(isValidHandoffPhone("+1 612 555 0100")).toBe(true);
    expect(isValidHandoffPhone("555-0100")).toBe(false);
    expect(isValidHandoffPhone("")).toBe(false);
  });

  it("blocks handoff when phone is missing or malformed", () => {
    const base = {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "",
    };
    expect(validateHandoff(base).ok).toBe(false);
    expect(validateHandoff({ ...base, phone: "abc" }).ok).toBe(false);
    expect(validateHandoff({ ...base, phone: "612-555-0100" }).ok).toBe(true);
  });

  it("formats a user summary for handoff transcript context", () => {
    expect(
      toUserSummary({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phone: "612-555-0100",
      })
    ).toBe("Talk to a person: Jane Doe · jane@example.com · 612-555-0100");
  });
});
