import { sleep } from "./sleep";

export interface RetryWithBackoffOptions<T> {
  maxAttempts?: number;
  /** Base delay in ms; multiplied by attempt index for linear backoff. */
  baseDelayMs?: number;
  /** Return true to retry after a failed/transient result. */
  shouldRetry: (result: T, attempt: number) => boolean;
}

/**
 * Run `fn` sequentially up to `maxAttempts` times with linear backoff
 * between retries. Never parallelizes attempts.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryWithBackoffOptions<T>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;

  async function runAfterFirst(
    attempt: number,
    result: T,
  ): Promise<T> {
    if (!options.shouldRetry(result, attempt) || attempt >= maxAttempts) {
      return result;
    }
    await sleep(baseDelayMs * attempt);
    const next = await fn(attempt + 1);
    return runAfterFirst(attempt + 1, next);
  }

  const first = await fn(1);
  return runAfterFirst(1, first);
}
