// @vitest-environment node
/**
 * Tests for POST /api/portal/register/patient.
 *
 * Focus: rate-limit / validation / duplicate-detection branches. We mock the
 * upstream Athena + Hint clients so the test stays hermetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// `server-only` throws when imported in a non-RSC context. PostHog's
// server singleton (added in PR #43) imports it, and `@/lib/portal/api`
// transitively pulls in the PostHog server module, so the test suite
// trips at module-load time without this shim.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/athena/client", () => ({
  AthenaApiError: class AthenaApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  enhancedBestMatch: vi.fn(),
  createPatient: vi.fn(),
}));

vi.mock("@/lib/hint/client", () => ({
  HintApiError: class HintApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  createPatient: vi.fn(),
}));

vi.mock("@/lib/portal/api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/portal/api")
  >("@/lib/portal/api");
  return {
    ...actual,
    idempotencyGet: vi.fn().mockResolvedValue(null),
    idempotencySet: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/portal/followup", () => ({
  recordFollowup: vi.fn().mockResolvedValue(undefined),
  mintPendingPatientId: vi.fn(() => "pending-test-uuid"),
  isPendingPatientId: (id: string) => id?.startsWith("pending-"),
}));

import { rateLimit } from "@/lib/rate-limit";
import {
  enhancedBestMatch,
  createPatient as createAthenaPatient,
} from "@/lib/athena/client";
import { POST } from "@/app/api/portal/register/patient/route";

const VALID_PAYLOAD = {
  firstname: "Jane",
  lastname: "Doe",
  dob: "1990-01-15",
  sex: "F",
  mobilephone: "+15551234567",
  email: "jane@example.com",
  departmentid: 1,
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/portal/register/patient", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/portal/register/patient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REGISTRATION_TOKEN_SECRET = "x".repeat(64);
    delete process.env.HINT_API_KEY;
    (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 3_600_000,
    });
  });

  it("returns 429 when rate-limited", async () => {
    (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 1000,
    });

    const res = await POST(makeRequest(VALID_PAYLOAD));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too many/i);
  });

  it("returns 400 for missing required fields", async () => {
    const { firstname, ...rest } = VALID_PAYLOAD;
    void firstname;
    const res = await POST(makeRequest(rest));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/firstname/);
  });

  it("returns 400 for badly formatted DOB", async () => {
    const res = await POST(
      makeRequest({ ...VALID_PAYLOAD, dob: "1/15/1990" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/dob/i);
  });

  it("returns 400 for non-E.164 mobilephone", async () => {
    const res = await POST(
      makeRequest({ ...VALID_PAYLOAD, mobilephone: "555-123-4567" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mobilephone/i);
  });

  it("returns duplicate flag (without leaking patientid) on strong EMPI match", async () => {
    (enhancedBestMatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { patientid: "secret-id", score: 99 },
    ]);

    const res = await POST(makeRequest(VALID_PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(body.message).toMatch(/sign in/i);
    expect(body).not.toHaveProperty("patientId");
    expect(JSON.stringify(body)).not.toContain("secret-id");
    expect(createAthenaPatient).not.toHaveBeenCalled();
  });

  it("returns regToken + patientId on successful registration", async () => {
    (enhancedBestMatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (createAthenaPatient as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      patientid: "999",
    });

    const res = await POST(makeRequest(VALID_PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.patientId).toBe("999");
    expect(typeof body.regToken).toBe("string");
    expect(body.regToken.split(".")).toHaveLength(3);
    expect(body.duplicate).toBeUndefined();
  });

  it("still succeeds even if EMPI lookup throws (treats as no match)", async () => {
    (enhancedBestMatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("athena down")
    );
    (createAthenaPatient as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      patientid: "1234",
    });

    const res = await POST(makeRequest(VALID_PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patientId).toBe("1234");
  });
});
