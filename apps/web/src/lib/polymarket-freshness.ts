/** Data older than this is treated as stale (missed pipeline runs). */
export const STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000;

/** Max `fetched_at` across a set of rows, or null if none have a valid timestamp. */
export function maxFetchedAt(fetchedAtValues: Array<string | null | undefined>): Date | null {
  let max: number | null = null;
  for (const value of fetchedAtValues) {
    if (!value) continue;
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) continue;
    if (max === null || t > max) max = t;
  }
  return max === null ? null : new Date(max);
}

/** "Xs ago" / "Xm ago" / "Xh ago" for a timestamp relative to `now` (both in ms epoch terms via Date). */
export function formatAge(since: Date, now: number): string {
  const secs = Math.max(0, Math.round((now - since.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/** Whether the data is old enough to warrant a "may be stale" state instead of a live badge. */
export function isStale(since: Date | null, now: number): boolean {
  if (!since) return false;
  return now - since.getTime() > STALE_THRESHOLD_MS;
}

/**
 * Detects a volume-fallback (curation-failed) match without the `source` provenance
 * column, which is queued separately. Swap to `match.source === "volume_fallback"`
 * once that column ships — this is the one line to change.
 */
export function isFallbackMatch(match: { score: number | null; reason: string | null }): boolean {
  return match.score === 0 && match.reason === null;
}
