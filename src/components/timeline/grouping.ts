/**
 * Group a flat, date-sorted asset list into the day sections Immich shows.
 *
 * Kept as a pure function so the bucketing rules can be tested without a
 * device or a render.
 *
 * Layout note: React Native's `SectionList` has no `numColumns`, so each
 * section's items are pre-chunked into rows here and a row is rendered as one
 * item. That also keeps row height constant, which is what lets
 * `getItemLayout` stay cheap on long lists.
 */

import { parseCanonicalPath } from '@/services/sync/pathScheme';

export type TimelineGroupable = {
  id: string;
  /**
   * Capture time in ms.
   *
   * Android MediaStore leaves `datetaken` NULL surprisingly often — measured on
   * 3 of 6 test photos that all carried valid EXIF — which dumped them into an
   * "Unknown date" bucket. `modificationTime` is populated in practice and is a
   * far better guess than no date at all, so it is used as a fallback.
   *
   * Uploaded assets get a proper EXIF-derived date via `resolveCaptureDate`;
   * this fallback only covers the local grid, where reading EXIF for every
   * asset on scroll would be too expensive.
   */
  creationTime?: number | null;
  modificationTime?: number | null;
  /** Cloud entries (`MetaEntry`) carry `createdAt`/`uploadedAt`, not `creationTime`. */
  createdAt?: number | null;
  uploadedAt?: number | null;
  /** Canonical repo path — the date can be recovered from it as a last resort. */
  repoPath?: string | null;
};

/**
 * Best timestamp available for grouping, or null when there is genuinely none.
 *
 * Local assets (`MediaLibrary.Asset`) and cloud entries (`MetaEntry`) use
 * different field names, and a timeline that only knew about the local shape
 * silently dumped every cloud photo into "Unknown date". Both are handled here
 * so the section list stays source-agnostic.
 *
 * The path is the final fallback: canonical paths encode the capture date, so
 * a cloud entry with no usable timestamp can still be placed correctly.
 */
export function groupingTimestamp(item: TimelineGroupable): number | null {
  const created = item.creationTime ?? 0;
  if (created > 0) return created;
  const modified = item.modificationTime ?? 0;
  if (modified > 0) return modified;

  const cloudCreated = item.createdAt ?? 0;
  if (cloudCreated > 0) return cloudCreated;

  if (item.repoPath) {
    const fromPath = parseCanonicalPath(item.repoPath).captureDate;
    if (fromPath) return fromPath.getTime();
  }

  const uploaded = item.uploadedAt ?? 0;
  if (uploaded > 0) return uploaded;
  return null;
}

/** Stable identity across both shapes, for list keys. */
export function groupingKey(item: any, fallback: string): string {
  return item?.id ?? item?.repoPath ?? item?.fingerprint ?? fallback;
}

export type TimelineSection<T> = {
  /** Stable key: `YYYY-MM-DD`, or `unknown`. */
  key: string;
  /** Midnight of the section's day, or null when the date is unknown. */
  date: Date | null;
  /** Whether this is the first section of its month — drives the larger header. */
  startsMonth: boolean;
  /** Total assets in the section (not rows). */
  count: number;
  /** Items pre-chunked into rows of `columns`. */
  data: T[][];
};

function dayKey(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function chunkRows<T>(items: T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return rows;
}

/**
 * Sections come back newest-first, matching Immich.
 *
 * Order is imposed here rather than inherited from the caller: the local list
 * arrives newest-first from MediaLibrary, but the cloud list arrives in meta
 * cache order, which rendered the timeline oldest-first with 2024 at the top.
 * Sorting explicitly makes both sources behave the same.
 *
 * Items within a day are also sorted newest-first. Undated items sort last —
 * they'd otherwise jump to the top and push real photos down.
 */
export function buildTimelineSections<T extends TimelineGroupable>(
  items: T[],
  columns: number,
): TimelineSection<T>[] {
  if (items.length === 0) return [];

  const order: string[] = [];
  const byDay = new Map<string, { date: Date | null; items: T[] }>();

  for (const item of items) {
    const ts = groupingTimestamp(item);
    const date = ts && ts > 0 ? new Date(ts) : null;
    const key = date ? dayKey(date) : 'unknown';
    let bucket = byDay.get(key);
    if (!bucket) {
      bucket = { date: date ? new Date(date.getFullYear(), date.getMonth(), date.getDate()) : null, items: [] };
      byDay.set(key, bucket);
      order.push(key);
    }
    bucket.items.push(item);
  }

  // Newest day first; 'unknown' always last regardless of the others.
  order.sort((a, b) => {
    const da = byDay.get(a)!.date;
    const db = byDay.get(b)!.date;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return db.getTime() - da.getTime();
  });

  for (const bucket of byDay.values()) {
    bucket.items.sort((x, y) => (groupingTimestamp(y) ?? 0) - (groupingTimestamp(x) ?? 0));
  }

  let previousMonth: string | null = null;
  return order.map((key) => {
    const bucket = byDay.get(key)!;
    const monthKey = bucket.date ? `${bucket.date.getFullYear()}-${bucket.date.getMonth()}` : 'unknown';
    const startsMonth = monthKey !== previousMonth;
    previousMonth = monthKey;
    return {
      key,
      date: bucket.date,
      startsMonth,
      count: bucket.items.length,
      data: chunkRows(bucket.items, columns),
    };
  });
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Immich drops the year for the current year (`_formatMonth`). */
export function formatMonthLabel(date: Date, now: Date = new Date()): string {
  const month = MONTHS[date.getMonth()];
  return date.getFullYear() === now.getFullYear() ? month : `${month} ${date.getFullYear()}`;
}

/** Immich's day header uses `yMMMEd`, e.g. "Sat, Sep 19, 2026". */
export function formatDayLabel(date: Date): string {
  const weekday = WEEKDAYS[date.getDay()];
  const month = MONTHS[date.getMonth()].slice(0, 3);
  return `${weekday}, ${month} ${date.getDate()}, ${date.getFullYear()}`;
}

/** `93` -> `1:33`. MediaLibrary reports duration in seconds. */
export function formatDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
