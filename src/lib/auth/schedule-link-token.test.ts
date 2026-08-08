// @vitest-environment node
// jose's HS256 signing encodes the payload with TextEncoder; under jsdom the
// resulting Uint8Array is from a different realm and fails jose's
// `instanceof Uint8Array` guard. Run this suite in the node environment.
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  ScheduleLinkTokenError,
  mintScheduleLinkToken,
  verifyScheduleLinkToken,
} from "./schedule-link-token";

// Ephemeral per-run secret (>=32 bytes) so no credential-like literal is committed.
const SECRET = randomBytes(48).toString("base64url");

beforeAll(() => {
  process.env.SCHEDULE_LINK_SECRET = SECRET;
});

describe("mint + verify round trip", () => {
  it("preserves claims and assigns a jti", async () => {
    const { token, jti } = await mintScheduleLinkToken({
      athenaPatientId: "12345",
      salesforceAccountId: "001abc",
      departmentId: 21,
      firstName: "Ada",
    });
    expect(token).toBeTruthy();
    expect(jti).toBeTruthy();

    const verified = await verifyScheduleLinkToken(token);
    expect(verified.athenaPatientId).toBe("12345");
    expect(verified.salesforceAccountId).toBe("001abc");
    expect(verified.departmentId).toBe(21);
    expect(verified.firstName).toBe("Ada");
    expect(verified.jti).toBe(jti);
    expect(verified.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("honors a caller-supplied jti", async () => {
    const { token } = await mintScheduleLinkToken({
      athenaPatientId: "1",
      jti: "fixed-jti-123",
    });
    const verified = await verifyScheduleLinkToken(token);
    expect(verified.jti).toBe("fixed-jti-123");
  });
});

describe("verify failures", () => {
  it("throws 'missing' when no token is supplied", async () => {
    await expect(verifyScheduleLinkToken(null)).rejects.toMatchObject({
      reason: "missing",
    } satisfies Partial<ScheduleLinkTokenError>);
  });

  it("throws 'invalid' on a tampered token", async () => {
    const { token } = await mintScheduleLinkToken({ athenaPatientId: "1" });
    const tampered = token.slice(0, -3) + "abc";
    await expect(verifyScheduleLinkToken(tampered)).rejects.toMatchObject({
      reason: "invalid",
    });
  });

  it("throws 'invalid' for a wrong-audience token", async () => {
    const secret = new TextEncoder().encode(SECRET);
    const wrongAud = await new SignJWT({ athenaPatientId: "1", jti: "x" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("patient-portal")
      .setAudience("some-other-audience")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    await expect(verifyScheduleLinkToken(wrongAud)).rejects.toMatchObject({
      reason: "invalid",
    });
  });

  it("throws 'expired' for a past-exp token", async () => {
    const secret = new TextEncoder().encode(SECRET);
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await new SignJWT({ athenaPatientId: "1", jti: "x" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("patient-portal")
      .setAudience("portal-schedule-link")
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(secret);
    await expect(verifyScheduleLinkToken(expired)).rejects.toMatchObject({
      reason: "expired",
    });
  });
});
