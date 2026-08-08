// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/salesforce/client", () => ({
  escapeSoql: (value: string) => value,
  SalesforceClient: {
    fromEnvironment: vi.fn(),
  },
}));

vi.mock("@/lib/business-hours", () => ({
  getChicagoBusinessWindow: vi.fn(),
}));

import { rateLimit } from "@/lib/rate-limit";
import { SalesforceClient } from "@/lib/salesforce/client";
import { getChicagoBusinessWindow } from "@/lib/business-hours";
import { POST } from "@/app/api/portal/register/handoff/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/portal/register/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/portal/register/handoff", () => {
  const mockQuery = vi.fn();
  const mockCreateRecord = vi.fn();
  const mockUpdateRecord = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60_000,
    });

    (SalesforceClient.fromEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        query: mockQuery,
        createRecord: mockCreateRecord,
        updateRecord: mockUpdateRecord,
      }
    );

    (getChicagoBusinessWindow as ReturnType<typeof vi.fn>).mockReturnValue({
      isOpenNow: false,
      nextBusinessDate: new Date("2026-04-27T12:00:00.000Z"),
      nextBusinessDateLabel: "Monday, April 27",
    });
  });

  it("returns 400 when required fields are missing", async () => {
    const response = await POST(
      makeRequest({ firstName: "Jane", lastName: "", email: "jane@example.com" })
    );
    expect(response.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    const response = await POST(
      makeRequest({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
      })
    );
    expect(response.status).toBe(429);
  });

  it("creates a new lead and returns off-hours message", async () => {
    mockQuery.mockResolvedValueOnce({ totalSize: 0, records: [] });
    mockCreateRecord.mockResolvedValueOnce({ id: "00QNEW", success: true });

    const response = await POST(
      makeRequest({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.leadId).toBe("00QNEW");
    expect(json.isNewLead).toBe(true);
    expect(json.contactWindow.message).toMatch(/Monday, April 27/);
    expect(mockCreateRecord).toHaveBeenCalledWith(
      "Lead",
      expect.objectContaining({
        FirstName: "Jane",
        LastName: "Doe",
        Email: "jane@example.com",
        LeadSource: "Membership",
      })
    );
  });

  it("updates an existing lead and returns call-now message", async () => {
    mockQuery.mockResolvedValueOnce({ totalSize: 1, records: [{ Id: "00QEXIST" }] });
    (getChicagoBusinessWindow as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      isOpenNow: true,
      nextBusinessDate: new Date("2026-04-27T12:00:00.000Z"),
      nextBusinessDateLabel: "Monday, April 27",
    });

    const response = await POST(
      makeRequest({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.isNewLead).toBe(false);
    expect(json.contactWindow.message).toMatch(/555-123-4567/);
    expect(mockUpdateRecord).toHaveBeenCalledWith(
      "Lead",
      "00QEXIST",
      expect.objectContaining({
        LeadSource: "Membership",
      })
    );
  });
});

