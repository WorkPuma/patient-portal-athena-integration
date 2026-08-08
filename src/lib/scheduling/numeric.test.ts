import { describe, expect, it } from "vitest";
import { toPositiveInt } from "./numeric";

describe("toPositiveInt", () => {
  it("accepts positive integer numbers and strings", () => {
    expect(toPositiveInt(21)).toBe(21);
    expect(toPositiveInt("21")).toBe(21);
    expect(toPositiveInt(" 289835213735561 ")).toBe(289835213735561);
  });

  it("rejects null/undefined/empty", () => {
    expect(toPositiveInt(null)).toBeNull();
    expect(toPositiveInt(undefined)).toBeNull();
    expect(toPositiveInt("")).toBeNull();
    expect(toPositiveInt("   ")).toBeNull();
  });

  it("rejects zero and negatives", () => {
    expect(toPositiveInt(0)).toBeNull();
    expect(toPositiveInt("0")).toBeNull();
    expect(toPositiveInt(-5)).toBeNull();
    expect(toPositiveInt("-5")).toBeNull();
  });

  it("rejects decimals and numeric-prefixed strings", () => {
    expect(toPositiveInt(1.5)).toBeNull();
    expect(toPositiveInt("1.5")).toBeNull();
    expect(toPositiveInt("12abc")).toBeNull();
    expect(toPositiveInt("abc")).toBeNull();
    expect(toPositiveInt("NaN")).toBeNull();
  });

  it("rejects values outside the safe integer range", () => {
    expect(toPositiveInt("99999999999999999999")).toBeNull();
  });
});
