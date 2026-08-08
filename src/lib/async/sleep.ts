/**
 * Promise-based delay without returning a value from the setTimeout executor
 * (avoids promise-executor lint noise).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
