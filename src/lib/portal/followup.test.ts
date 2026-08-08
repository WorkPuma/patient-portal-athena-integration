// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const captureMocks = vi.hoisted(() => ({
  captureServerException: vi.fn(),
  captureServerMessage: vi.fn(),
}));

// `server-only` blows up outside an RSC context — the followup module imports
// it for the prod build but in unit tests we want a no-op.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/capture-exception", () => captureMocks);

const { captureServerException, captureServerMessage } = captureMocks;

const insertSpy = vi.fn();
const selectSpy = vi.fn();
const singleSpy = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        insertSpy(row);
        return {
          select: () => {
            selectSpy();
            return {
              single: async () => {
                singleSpy();
                return { data: { id: "row-1" }, error: null };
              },
            };
          },
        };
      },
    }),
  })),
}));

import {
  recordFollowup,
  mintPendingPatientId,
  isPendingPatientId,
} from "./followup";

beforeEach(() => {
  insertSpy.mockClear();
  selectSpy.mockClear();
  singleSpy.mockClear();
  (captureServerMessage as unknown as ReturnType<typeof vi.fn>).mockClear();
  (captureServerException as unknown as ReturnType<typeof vi.fn>).mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
});

describe("mintPendingPatientId / isPendingPatientId", () => {
  it("mints ids prefixed with 'pending-'", () => {
    const id = mintPendingPatientId();
    expect(id.startsWith("pending-")).toBe(true);
  });

  it("recognizes pending ids and rejects real ones", () => {
    expect(isPendingPatientId("pending-abc")).toBe(true);
    expect(isPendingPatientId("12345")).toBe(false);
    expect(isPendingPatientId(null)).toBe(false);
    expect(isPendingPatientId(undefined)).toBe(false);
  });
});

describe("recordFollowup", () => {
  it("inserts a 'success' row with default outcome/severity/status", async () => {
    const id = await recordFollowup({
      step: "patient_create",
      athenaPatientId: "athena-1",
      payload: { firstname: "Jane" },
      result: { athenaPatientId: "athena-1" },
    });
    expect(id).toBe("row-1");
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const row = insertSpy.mock.calls[0][0];
    expect(row.step).toBe("patient_create");
    expect(row.outcome).toBe("success");
    expect(row.severity).toBe("info");
    expect(row.status).toBe("resolved");
    expect(row.athena_patient_id).toBe("athena-1");
    expect(row.result).toEqual({ athenaPatientId: "athena-1" });
    expect(row.error_message).toBeNull();
  });

  it("derives 'soft_failed' / 'soft' / 'pending' when an error is present", async () => {
    await recordFollowup({
      step: "eligibility_check",
      error: new Error("Stedi 502"),
      payload: {},
    });
    const row = insertSpy.mock.calls[0][0];
    expect(row.outcome).toBe("soft_failed");
    expect(row.severity).toBe("soft");
    expect(row.status).toBe("pending");
    expect(row.error_message).toBe("Stedi 502");
    expect(row.result).toBeNull();
  });

  it("respects explicit overrides for outcome/status/severity", async () => {
    await recordFollowup({
      step: "appointment_book",
      outcome: "soft_failed",
      status: "resolved",
      severity: "info",
      error: "slot taken",
    });
    const row = insertSpy.mock.calls[0][0];
    expect(row.outcome).toBe("soft_failed");
    expect(row.status).toBe("resolved");
    expect(row.severity).toBe("info");
  });

  it("redacts secret-like payload keys", async () => {
    await recordFollowup({
      step: "insurance_attach",
      payload: {
        memberId: "ABC123",
        nested: { authorization: "Bearer xyz", normal: "ok" },
        apiKey: "sk-leaked",
      },
    });
    const row = insertSpy.mock.calls[0][0];
    expect(row.payload.memberId).toBe("ABC123");
    expect(row.payload.apiKey).toBe("[redacted]");
    expect(row.payload.nested.authorization).toBe("[redacted]");
    expect(row.payload.nested.normal).toBe("ok");
  });

  it("returns null and logs to Sentry when Supabase env is missing for failures", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.doMock("server-only", () => ({}));
    const captureMessage = vi.fn();
    vi.doMock("@/lib/capture-exception", () => ({
      captureServerException: vi.fn(),
      captureServerMessage: captureMessage,
    }));
    const fresh = await import("./followup");
    const id = await fresh.recordFollowup({
      step: "patient_create",
      error: new Error("boom"),
    });
    expect(id).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("never throws on unexpected internal errors", async () => {
    const id = await recordFollowup({ step: "patient_create" });
    expect(typeof id === "string" || id === null).toBe(true);
  });
});
