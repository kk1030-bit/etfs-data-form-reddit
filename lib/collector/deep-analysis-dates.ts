export const DEEP_WINDOW_MS = 7 * 86400000;
const DAY_MS = 86400000;
export const deepBeijingDay = (publishedAt: string) =>
  new Date(Date.parse(publishedAt) + 8 * 3600000).toISOString().slice(0, 10);

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
    deepBeijingDay(b.publishedAt).localeCompare(
      deepBeijingDay(a.publishedAt),
    ) ||
    b.score - a.score ||
    Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
    a.id.localeCompare(b.id)
  );
}

export function defaultDeepView(
  articles: Array<{ publishedAt: string; id: string }> | undefined,
  now: number,
): 'deep' | 'top' {
  const recent = new Set(
    (articles ?? [])
      .filter((a) => {
        const at = Date.parse(a.publishedAt);
        return Number.isFinite(at) && at <= now && at >= now - DEEP_WINDOW_MS;
      })
      .map((a) => a.id),
  );
  return recent.size >= 3 ? 'deep' : 'top';
}

export function deepReviewSchedule(
  run:
    | {
        day: string;
        status: string;
        startedAt?: string;
        completedAt?: string | null;
        accepted: number;
      }
    | null
    | undefined,
  now: number,
  unavailable = false,
) {
  const utcDay = Math.floor(now / DAY_MS) * DAY_MS;
  const today = new Date(utcDay).toISOString().slice(0, 10);
  const due = utcDay + 30 * 60000;
  const lastDue = due <= now ? due : due - DAY_MS;
  const expectedDay = new Date(lastDue).toISOString().slice(0, 10);
  const next = due > now && run?.day !== today ? due : due + DAY_MS;
  const started = Date.parse(run?.startedAt ?? '');
  const lastAt = Number.isFinite(started)
    ? new Date(started).toISOString()
    : null;
  let status = '尚未执行';
  if (run?.status === 'completed') status = `已完成 · ${run.accepted} 篇通过`;
  else if (run?.status === 'partial') status = '部分失败 · 已保留通过的文章';
  else if (run?.status === 'failed') status = '采集失败';
  else if (run)
    status =
      Number.isFinite(started) && now - started > 20 * 60000
        ? '处理中断或超时'
        : '审查进行中';
  if ((!run || run.day < expectedDay) && now >= lastDue + 20 * 60000)
    status = run ? `${status}；本轮未执行／排程延迟` : '本轮未执行／排程延迟';
  if (unavailable) status = '状态暂不可用';
  return { lastAt, nextAt: new Date(next).toISOString(), status };
}

export function deepIsNew(publishedAt: string, now = Date.now()): boolean {
  const ms = Date.parse(publishedAt);
  const beijingDay = Math.floor((now + 8 * 3600000) / 86400000);
  const yesterday = (beijingDay - 1) * 86400000 - 8 * 3600000;
  return Number.isFinite(ms) && ms >= yesterday && ms <= now;
}
