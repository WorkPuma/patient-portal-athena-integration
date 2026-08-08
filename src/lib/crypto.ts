import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison.
 *
 * Returns true only when `a` and `b` are the same length AND content.
 * Avoids early-exit timing leaks when comparing secrets (admin tokens,
 * webhook secrets). Use this instead of `===` for any secret comparison.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still do a comparison to keep timing roughly independent of length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
