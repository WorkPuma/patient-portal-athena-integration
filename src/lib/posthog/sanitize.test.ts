import { describe, it, expect, vi } from "vitest";
import {
  BLOCKED_PROPERTY_KEYS,
  sanitizeProperties,
  isOpaqueDistinctId,
  assertOpaqueDistinctId,
  hashToOpaqueDistinctId,
} from "./sanitize";
import { isValidAnonId } from "./anon-id";

describe("posthog/sanitize", () => {
  describe("sanitizeProperties", () => {
    it("returns empty object when given undefined", () => {
      expect(sanitizeProperties(undefined)).toEqual({});
    });

    it("strips direct identifier keys", () => {
      const out = sanitizeProperties({
        email: "patti@example.com",
        firstName: "Patti",
        lastName: "Madison",
        dob: "1950-07-04",
        ssn: "123-45-6789",
        keepMe: "ok",
      });
      expect(out).toEqual({ keepMe: "ok" });
    });

    it("strips insurance / clinical identifiers", () => {
      const out = sanitizeProperties({
        mrn: "M-12345",
        memberId: "ABC123",
        member_id: "ABC123",
        subscriberId: "S-1",
        groupNumber: "G-9",
        mbi: "1EG4-TE5-MK73",
        athenaPatientId: "67890",
        athena_patient_id: "67890",
        brandId: "bcbs-mn",
      });
      expect(out).toEqual({ brandId: "bcbs-mn" });
    });

    it("normalizes camelCase, snake_case, and mixed case", () => {
      const out = sanitizeProperties({
        EMAIL: "x",
        Phone_Number: "x",
        mobilephone: "x",
        Address1: "x",
        zipCode: "x",
        plan: "kept",
      });
      expect(Object.keys(out)).toEqual(["plan"]);
    });

    it("warns in dev when dropping a key", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
      sanitizeProperties({ email: "x" });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("blocklist is non-empty", () => {
      expect(BLOCKED_PROPERTY_KEYS.size).toBeGreaterThan(20);
    });
  });

  describe("isOpaqueDistinctId / assertOpaqueDistinctId", () => {
    it("accepts Clerk user ids", () => {
      expect(isOpaqueDistinctId("user_2abcDEF123")).toBe(true);
      expect(assertOpaqueDistinctId("user_2abcDEF123")).toBe(true);
    });

    it("accepts hh: hex blobs of valid length", () => {
      const hex = "a".repeat(64);
      expect(isOpaqueDistinctId(`hh:${hex}`)).toBe(true);
      expect(assertOpaqueDistinctId(`hh:${hex}`)).toBe(true);
    });

    it("accepts first-party marketing visitor UUIDs (hh_did)", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      expect(isValidAnonId(uuid)).toBe(true);
      expect(isOpaqueDistinctId(uuid)).toBe(true);
      expect(assertOpaqueDistinctId(uuid)).toBe(true);
    });

    it("rejects raw Athena PIDs", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => { });
      expect(isOpaqueDistinctId("athena:12345")).toBe(false);
      expect(assertOpaqueDistinctId("athena:12345")).toBe(false);
      expect(isOpaqueDistinctId("12345")).toBe(false);
      expect(assertOpaqueDistinctId("12345")).toBe(false);
      err.mockRestore();
    });

    it("rejects emails and other PII shapes", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => { });
      expect(assertOpaqueDistinctId("patti@example.com")).toBe(false);
      expect(assertOpaqueDistinctId("Patti Madison")).toBe(false);
      expect(assertOpaqueDistinctId("")).toBe(false);
      err.mockRestore();
    });
  });

  describe("hashToOpaqueDistinctId", () => {
    it("produces a stable hh:<64-hex> string", async () => {
      const out = await hashToOpaqueDistinctId("12345");
      expect(out).toMatch(/^hh:[a-f0-9]{64}$/);
    });

    it("is deterministic for the same input", async () => {
      const a = await hashToOpaqueDistinctId("12345");
      const b = await hashToOpaqueDistinctId("12345");
      expect(a).toBe(b);
    });

    it("returns distinct hashes for distinct inputs", async () => {
      const a = await hashToOpaqueDistinctId("12345");
      const b = await hashToOpaqueDistinctId("12346");
      expect(a).not.toBe(b);
    });

    it("output is itself an opaque distinct id", async () => {
      const out = await hashToOpaqueDistinctId("67890");
      expect(isOpaqueDistinctId(out)).toBe(true);
    });
  });
});
