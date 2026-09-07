export const DEEP_WINDOW_MS = 7 * 86400000;

/** Reddit created_utc is epoch seconds, never retrieved_on or first-seen time. */
export function deepPublishedMs(
  value: unknown,
  now = Date.now(),
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return null;
  const ms = value * 1000;
  return ms <= now && ms >= now - DEEP_WINDOW_MS ? ms : null;
}

export function compareDeepRecent(
  a: { publishedAt: string; score: number; id: string },
  b: { publishedAt: string; score: number; id: string },
): number {
  return (
    Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
    b.score - a.score ||
    a.id.localeCompare(b.id)
  );
}

export function deepIsNew(publishedAt: string, now = Date.now()): boolean {
  const ms = Date.parse(publishedAt);
  const beijingDay = Math.floor((now + 8 * 3600000) / 86400000);
  const yesterday = (beijingDay - 1) * 86400000 - 8 * 3600000;
  return Number.isFinite(ms) && ms >= yesterday && ms <= now;
}
