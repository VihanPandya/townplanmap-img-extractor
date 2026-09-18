export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Run `worker` over `items` with a fixed number of slots.
 * Rejections are surfaced to the caller as settled results so one bad asset
 * cannot abort a whole batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let cursor = 0;
  const slots = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(
    Array.from({ length: slots }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          results[index] = { ok: true, value: await worker(items[index]!, index) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    }),
  );

  return results;
}
