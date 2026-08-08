import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff } from "./retry";
import { sleep } from "./sleep";

vi.mock("./sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

describe("retryWithBackoff", () => {
  it("returns immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true });
    const result = await retryWithBackoff(fn, {
      shouldRetry: (r: { ok: boolean }) => !r.ok,
    });
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries sequentially until shouldRetry returns false", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      shouldRetry: (r: { ok: boolean }) => !r.ok,
    });

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("returns last result when max attempts exhausted", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: false });
    const result = await retryWithBackoff(fn, {
      maxAttempts: 2,
      shouldRetry: () => true,
    });
    expect(result).toEqual({ ok: false });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
