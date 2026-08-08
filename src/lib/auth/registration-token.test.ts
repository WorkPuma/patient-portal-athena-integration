// @vitest-environment node
/**
 * Unit tests for src/lib/auth/registration-token.ts
 *
 * Covers minting, verification, expiry, audience/issuer mismatch, missing
 * required claims, and the dobHash helpers.
 *
 * Runs under the `node` test environment because jose's WebCrypto path is
 * brittle inside jsdom (TextEncoder polyfill mismatch).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";

import {
  mintRegistrationToken,
  verifyRegistrationToken,
  hashDob,
  dobMatches,
  RegistrationTokenError,
  readRegistrationTokenFromHeader,
  type RegistrationTokenClaims,
} from "./registration-token";

const TEST_SECRET = "a".repeat(64);

const baseClaims: RegistrationTokenClaims = {
  athenaPatientId: "12345",
  hintPatientId: "h_67890",
  departmentId: 1,
  dobHash: "abc123",
  phone: "+15551234567",
  email: "test@example.com",
  firstName: "Jane",
  lastName: "Doe",
};

describe("registration-token", () => {
  beforeEach(() => {
    process.env.REGISTRATION_TOKEN_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    delete process.env.REGISTRATION_TOKEN_SECRET;
    vi.useRealTimers();
  });

  describe("hashDob / dobMatches", () => {
    it("hashes deterministically for the same DOB+secret", () => {
      expect(hashDob("1990-01-15")).toBe(hashDob("1990-01-15"));
    });

    it("produces different hashes for different DOBs", () => {
      expect(hashDob("1990-01-15")).not.toBe(hashDob("1990-01-16"));
    });

    it("dobMatches returns true for matching DOB", () => {
      const h = hashDob("1990-01-15");
      expect(dobMatches("1990-01-15", h)).toBe(true);
    });

    it("dobMatches returns false for non-matching DOB", () => {
      const h = hashDob("1990-01-15");
      expect(dobMatches("1990-01-16", h)).toBe(false);
    });
  });

  describe("mintRegistrationToken / verifyRegistrationToken", () => {
    it("round-trips claims successfully", async () => {
      const token = await mintRegistrationToken(baseClaims);
      const verified = await verifyRegistrationToken(token);

      expect(verified.athenaPatientId).toBe(baseClaims.athenaPatientId);
      expect(verified.hintPatientId).toBe(baseClaims.hintPatientId);
      expect(verified.departmentId).toBe(baseClaims.departmentId);
      expect(verified.dobHash).toBe(baseClaims.dobHash);
      expect(verified.email).toBe(baseClaims.email);
      expect(verified.exp).toBeGreaterThan(verified.iat);
    });

    it("throws RegistrationTokenError(missing) for empty token", async () => {
      await expect(verifyRegistrationToken("")).rejects.toThrow(
        RegistrationTokenError
      );
      await expect(verifyRegistrationToken(null)).rejects.toThrow(
        RegistrationTokenError
      );
    });

    it("throws RegistrationTokenError(invalid) for tampered token", async () => {
      const token = await mintRegistrationToken(baseClaims);
      const tampered = token.slice(0, -2) + "AB";
      try {
        await verifyRegistrationToken(tampered);
        throw new Error("expected verifyRegistrationToken to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RegistrationTokenError);
        expect((err as RegistrationTokenError).reason).toBe("invalid");
      }
    });

    it("throws RegistrationTokenError(invalid) when secret rotates", async () => {
      const token = await mintRegistrationToken(baseClaims);
      process.env.REGISTRATION_TOKEN_SECRET = "b".repeat(64);
      try {
        await verifyRegistrationToken(token);
        throw new Error("expected verifyRegistrationToken to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RegistrationTokenError);
        expect((err as RegistrationTokenError).reason).toBe("invalid");
      }
    });

    it("throws RegistrationTokenError(expired) when past TTL", async () => {
      const token = await mintRegistrationToken(baseClaims, 1);
      // Advance 5 seconds — well past 1s TTL.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 5_000);
      try {
        await verifyRegistrationToken(token);
        throw new Error("expected verifyRegistrationToken to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RegistrationTokenError);
        expect((err as RegistrationTokenError).reason).toBe("expired");
      }
    });

    it("rejects tokens minted for a different audience", async () => {
      // Mint manually with a different audience string.
      const secret = new TextEncoder().encode(TEST_SECRET);
      const wrongAud = await new SignJWT({ ...baseClaims })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("patient-portal")
        .setAudience("portal-other")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret);

      try {
        await verifyRegistrationToken(wrongAud);
        throw new Error("expected verifyRegistrationToken to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RegistrationTokenError);
        expect((err as RegistrationTokenError).reason).toBe("invalid");
      }
    });

    it("rejects tokens minted by a different issuer", async () => {
      const secret = new TextEncoder().encode(TEST_SECRET);
      const wrongIss = await new SignJWT({ ...baseClaims })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("other-issuer")
        .setAudience("portal-register")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret);

      try {
        await verifyRegistrationToken(wrongIss);
        throw new Error("expected verifyRegistrationToken to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RegistrationTokenError);
        expect((err as RegistrationTokenError).reason).toBe("invalid");
      }
    });

    it("throws when REGISTRATION_TOKEN_SECRET is missing", async () => {
      delete process.env.REGISTRATION_TOKEN_SECRET;
      await expect(mintRegistrationToken(baseClaims)).rejects.toThrow(
        /REGISTRATION_TOKEN_SECRET/
      );
    });

    it("throws when REGISTRATION_TOKEN_SECRET is too short", async () => {
      process.env.REGISTRATION_TOKEN_SECRET = "tooshort";
      await expect(mintRegistrationToken(baseClaims)).rejects.toThrow(
        /REGISTRATION_TOKEN_SECRET/
      );
    });
  });

  describe("readRegistrationTokenFromHeader", () => {
    it("extracts a Bearer token", () => {
      expect(readRegistrationTokenFromHeader("Bearer abc.def.ghi")).toBe(
        "abc.def.ghi"
      );
    });

    it("is case-insensitive on the scheme", () => {
      expect(readRegistrationTokenFromHeader("bearer abc.def.ghi")).toBe(
        "abc.def.ghi"
      );
    });

    it("returns null for missing or malformed headers", () => {
      expect(readRegistrationTokenFromHeader(null)).toBeNull();
      expect(readRegistrationTokenFromHeader("")).toBeNull();
      expect(readRegistrationTokenFromHeader("Token abc")).toBeNull();
      expect(readRegistrationTokenFromHeader("Bearer")).toBeNull();
    });
  });
});
