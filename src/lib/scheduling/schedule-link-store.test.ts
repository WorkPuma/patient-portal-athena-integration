import { describe, expect, it } from "vitest";
import {
  canConsume,
  generateOpaqueToken,
  toLinkState,
} from "./schedule-link-store";
import { looksLikeJwt } from "./schedule-link-session";

describe("toLinkState", () => {
  it("maps redis values to states", () => {
    expect(toLinkState("active")).toBe("active");
    expect(toLinkState("used")).toBe("used");
    expect(toLinkState(null)).toBe("missing");
    expect(toLinkState(undefined)).toBe("missing");
    expect(toLinkState("garbage")).toBe("missing");
  });
});

describe("canConsume (single-use decision)", () => {
  it("only an active link may be consumed", () => {
    expect(canConsume("active")).toBe(true);
  });

  it("a used link cannot be consumed again", () => {
    expect(canConsume("used")).toBe(false);
  });

  it("a missing/expired link cannot be consumed", () => {
    expect(canConsume("missing")).toBe(false);
  });
});

describe("generateOpaqueToken", () => {
  it("returns a non-JWT opaque string with enough entropy", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(looksLikeJwt(a)).toBe(false);
    expect(a.includes(".")).toBe(false);
  });
});

describe("looksLikeJwt", () => {
  it("detects compact JWTs vs opaque tokens", () => {
    expect(looksLikeJwt("aaa.bbb.ccc")).toBe(true);
    expect(looksLikeJwt("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).toBe(
      true
    );
    expect(looksLikeJwt("opaque-token-without-dots")).toBe(false);
    expect(looksLikeJwt("only.two")).toBe(false);
  });
});
