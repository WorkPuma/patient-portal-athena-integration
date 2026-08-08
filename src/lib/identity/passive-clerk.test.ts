import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUserList = vi.fn();
const createUser = vi.fn();
const updateUser = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: () =>
    Promise.resolve({
      users: { getUserList, createUser, updateUser },
    }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(() => "sentry-evt-id"),
  captureMessage: vi.fn(),
}));

import { createPassiveClerkUser } from "./passive-clerk";

const validInput = {
  phone: "+15551234567",
  email: "patient@example.com",
  firstName: "Anna",
  lastName: "Booker",
  athenaPatientId: "126317",
  hintPatientId: "hint_abc",
  departmentId: 2,
};

beforeEach(() => {
  getUserList.mockReset();
  createUser.mockReset();
  updateUser.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createPassiveClerkUser", () => {
  it("skips when phone is missing or not E.164", async () => {
    const a = await createPassiveClerkUser({
      ...validInput,
      phone: "",
    });
    expect(a).toEqual({ status: "skipped", reason: "invalid_phone" });

    const b = await createPassiveClerkUser({
      ...validInput,
      phone: "555-1234",
    });
    expect(b).toEqual({ status: "skipped", reason: "invalid_phone" });

    expect(getUserList).not.toHaveBeenCalled();
  });

  it("creates a dormant user when no Clerk user exists for the phone", async () => {
    // Phone lookup empty, then email-fallback lookup also empty → create.
    getUserList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    createUser.mockResolvedValueOnce({ id: "user_new" });

    const result = await createPassiveClerkUser(validInput);

    expect(getUserList).toHaveBeenCalledWith({
      phoneNumber: ["+15551234567"],
    });
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: ["+15551234567"],
        emailAddress: ["patient@example.com"],
        firstName: "Anna",
        lastName: "Booker",
        skipPasswordRequirement: true,
        skipPasswordChecks: true,
      })
    );
    expect(result).toEqual({
      clerkUserId: "user_new",
      status: "created",
    });
  });

  it("patches existing user metadata when phone already maps to a Clerk user", async () => {
    getUserList.mockResolvedValueOnce({
      data: [
        {
          id: "user_existing",
          publicMetadata: { foo: "bar" },
        },
      ],
    });

    const result = await createPassiveClerkUser(validInput);

    expect(createUser).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledWith(
      "user_existing",
      expect.objectContaining({
        publicMetadata: expect.objectContaining({
          foo: "bar",
          athenaPatientId: "126317",
          hintPatientId: "hint_abc",
          source: "passive_registration",
        }),
      })
    );
    expect(result.status).toBe("patched_existing");
    expect(result.clerkUserId).toBe("user_existing");
  });

  it("falls back to email lookup when phone lookup is empty", async () => {
    getUserList
      .mockResolvedValueOnce({ data: [] }) // phone lookup empty
      .mockResolvedValueOnce({ data: [{ id: "user_by_email" }] });

    const result = await createPassiveClerkUser(validInput);

    expect(getUserList).toHaveBeenNthCalledWith(2, {
      emailAddress: ["patient@example.com"],
    });
    expect(updateUser).toHaveBeenCalledWith(
      "user_by_email",
      expect.any(Object)
    );
    expect(result.status).toBe("patched_existing");
  });

  it("returns error status (does NOT throw) when Clerk createUser blows up", async () => {
    getUserList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    createUser.mockRejectedValueOnce(new Error("422 phone_in_use"));

    const result = await createPassiveClerkUser(validInput);

    expect(result.status).toBe("error");
    expect(result.sentryEventId).toBe("sentry-evt-id");
  });

  it("omits emailAddress when no email is provided", async () => {
    // No email → only the phone lookup runs.
    getUserList.mockResolvedValueOnce({ data: [] });
    createUser.mockResolvedValueOnce({ id: "user_phone_only" });

    await createPassiveClerkUser({ ...validInput, email: undefined });

    expect(createUser).toHaveBeenCalledWith(
      expect.not.objectContaining({ emailAddress: expect.anything() })
    );
  });
});
