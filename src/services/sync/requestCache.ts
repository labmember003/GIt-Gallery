/**
 * Request coalescing and conditional-request caching for the GitHub API.
 *
 * Two problems this solves, both observed on device:
 *
 * 1. **Duplicate concurrent requests.** Two callers hydrate the meta index at
 *    once, producing identical GETs 6–26 ms apart and — when they both then
 *    write — a `PUT … 409`. That doubles consumption of a 5,000/hour budget
 *    and causes real write conflicts.
 *
 * 2. **Re-fetching unchanged data.** GitHub documents that a conditional
 *    request returning `304 Not Modified` **does not count against the primary
 *    rate limit** (verified: `x-ratelimit-remaining` unchanged at 4999 across
 *    a 200 then a 304). Polling for changes can therefore be free.
 */

type Pending<T> = { promise: Promise<T>; startedAt: number };

const inFlight = new Map<string, Pending<any>>();

/** Count of requests avoided by coalescing — surfaced for diagnostics. */
let coalescedHits = 0;

export function getCoalescedHits(): number {
  return coalescedHits;
}

/**
 * Run `fn` once per key while a call is already in flight.
 *
 * Callers that arrive during the window share the first promise, so N
 * simultaneous requests for the same resource cost exactly one round trip.
 * The entry is cleared on settle, so this is a coalescer, not a cache — it
 * never serves stale data to a later, separate call.
 */
export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    coalescedHits += 1;
    if (__DEV__) {
      console.log(`[coalesce] deduped duplicate request (+${Date.now() - existing.startedAt}ms): ${key}`);
    }
    return existing.promise as Promise<T>;
  }

  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, { promise, startedAt: Date.now() });
  return promise;
}

/** Number of requests currently coalescing — used by tests and diagnostics. */
export function inFlightCount(): number {
  return inFlight.size;
}

export function clearInFlight(): void {
  inFlight.clear();
}

// ── Conditional requests ────────────────────────────────────────────────────

type EtagEntry<T> = { etag: string; value: T; storedAt: number };

const etagCache = new Map<string, EtagEntry<any>>();

export function getEtag(key: string): string | null {
  return etagCache.get(key)?.etag ?? null;
}

export function getCachedValue<T>(key: string): T | undefined {
  return etagCache.get(key)?.value as T | undefined;
}

export function storeEtag<T>(key: string, etag: string | null | undefined, value: T): void {
  if (!etag) return;
  etagCache.set(key, { etag, value, storedAt: Date.now() });
}

export function invalidateEtag(key: string): void {
  etagCache.delete(key);
}

export function clearEtagCache(): void {
  etagCache.clear();
}

/**
 * Perform a request with `If-None-Match`, returning the cached value on 304.
 *
 * `fn` receives the stored etag (or null) and must surface the response's own
 * etag so it can be stored for next time. A 304 is delivered by throwing an
 * error with `status === 304`, which is how Octokit reports it.
 */
export async function conditionalRequest<T>(
  key: string,
  fn: (etag: string | null) => Promise<{ value: T; etag?: string | null }>,
): Promise<{ value: T; fromCache: boolean }> {
  const etag = getEtag(key);
  try {
    const result = await fn(etag);
    storeEtag(key, result.etag, result.value);
    return { value: result.value, fromCache: false };
  } catch (error: any) {
    if (error?.status === 304) {
      const cached = getCachedValue<T>(key);
      if (cached !== undefined) return { value: cached, fromCache: true };
      // Cache was dropped but the server still thinks we have it — retry clean.
      invalidateEtag(key);
      const retry = await fn(null);
      storeEtag(key, retry.etag, retry.value);
      return { value: retry.value, fromCache: false };
    }
    throw error;
  }
}
