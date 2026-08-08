import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getClientPortalFeatureFlags,
  getPortalFeatureFlags,
  getPublicPortalFeatureFlags,
  __FOR_TESTS_ONLY,
} from "./feature-flags";

const ENV_KEYS = [
  "NEXT_PUBLIC_PORTAL_DOT_ENABLED",
  "NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED",
  "NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED",
  "PORTAL_PASSIVE_CLERK_ENABLED",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = originalEnv[k];
    }
  }
});

describe("getPortalFeatureFlags", () => {
  it("returns the documented defaults when no env vars are set", () => {
    expect(getPortalFeatureFlags()).toEqual({
      dot: false,
      membership: false,
      authUi: false,
      passiveClerk: true,
    });
  });

  it("turns Dot on when the env var is truthy", () => {
    process.env.NEXT_PUBLIC_PORTAL_DOT_ENABLED = "1";
    expect(getPortalFeatureFlags().dot).toBe(true);
    process.env.NEXT_PUBLIC_PORTAL_DOT_ENABLED = "true";
    expect(getPortalFeatureFlags().dot).toBe(true);
    process.env.NEXT_PUBLIC_PORTAL_DOT_ENABLED = "ON";
    expect(getPortalFeatureFlags().dot).toBe(true);
  });

  it("explicit false wins over default-true (passive Clerk kill switch)", () => {
    process.env.PORTAL_PASSIVE_CLERK_ENABLED = "0";
    expect(getPortalFeatureFlags().passiveClerk).toBe(false);
  });

  it("ignores unrecognized values and falls back to the default", () => {
    process.env.NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED = "maybe";
    expect(getPortalFeatureFlags().membership).toBe(false);
  });
});

describe("public flag accessors", () => {
  it("hide the server-only passiveClerk flag", () => {
    process.env.NEXT_PUBLIC_PORTAL_DOT_ENABLED = "1";
    const pub = getPublicPortalFeatureFlags();
    expect(pub).toEqual({ dot: true, membership: false, authUi: false });
    expect(pub).not.toHaveProperty("passiveClerk");
  });

  it("getClientPortalFeatureFlags matches getPublicPortalFeatureFlags", () => {
    process.env.NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED = "true";
    expect(getClientPortalFeatureFlags()).toEqual(
      getPublicPortalFeatureFlags()
    );
  });
});

describe("parseFlag (internal)", () => {
  const { parseFlag } = __FOR_TESTS_ONLY;
  it("treats common truthy strings as true", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(parseFlag(v, false)).toBe(true);
    }
  });

  it("treats common falsy strings as false", () => {
    for (const v of ["0", "false", "no", "off", "OFF"]) {
      expect(parseFlag(v, true)).toBe(false);
    }
  });

  it("falls back to the default for empty/undefined/garbage", () => {
    expect(parseFlag(undefined, true)).toBe(true);
    expect(parseFlag("", false)).toBe(false);
    expect(parseFlag("nonsense", true)).toBe(true);
  });
});
