export type HourlyCollectionRecord = {
  hour: string;
  status: string;
  selected: number;
};

export type HourlyCollectionSlot = {
  hour: string;
  status:
    | 'completed'
    | 'running'
    | 'failed'
    | 'cooldown'
    | 'deferred'
    | 'not_run'
    | 'unknown';
  selected: number | null;
};

const HOUR = 3_600_000;
const recordedStatuses = new Set([
  'completed',
  'running',
  'failed',
  'cooldown',
  'deferred',
]);

/** Display-only slots: missing hours never create collection records or counts. */
export function hourlyCollectionHistory(
  records: readonly HourlyCollectionRecord[] | null | undefined,
  checkedAtMs: number,
  unavailable = false,
): HourlyCollectionSlot[] {
  if (!Number.isFinite(checkedAtMs)) return [];
  const end = Math.floor(checkedAtMs / HOUR) * HOUR;
  const start = end - 23 * HOUR;
  const readable = !unavailable && Array.isArray(records);
  const byHour = new Map<number, HourlyCollectionRecord>();
  if (readable) {
    for (const record of records) {
      const hour = Date.parse(record.hour);
      if (
        !Number.isFinite(hour) ||
        hour % HOUR !== 0 ||
        hour < start ||
        hour > end
      )
        continue;
      // A later attempt must not erase a confirmed success in the same hour.
      if (byHour.get(hour)?.status !== 'completed') byHour.set(hour, record);
    }
  }
  return Array.from({ length: 24 }, (_, index) => {
    const hour = start + index * HOUR;
    const record = byHour.get(hour);
    return {
      hour: new Date(hour).toISOString(),
      status: record
        ? recordedStatuses.has(record.status)
          ? (record.status as HourlyCollectionSlot['status'])
          : 'unknown'
        : readable
          ? 'not_run'
          : 'unknown',
      selected:
        record?.status === 'completed' &&
        Number.isInteger(record.selected) &&
        record.selected >= 0
          ? record.selected
          : null,
    };
  });
}

export function hourlyCollectionLabel(slot: HourlyCollectionSlot): string {
  switch (slot.status) {
    case 'completed':
      return slot.selected === null ? '完成' : `${slot.selected} 篇`;
    case 'running':
      return '采集中';
    case 'failed':
      return '失败';
    case 'cooldown':
      return '冷却';
    case 'deferred':
      return '暂缓';
    case 'not_run':
      return '未执行';
    default:
      return '状态未知';
  }
}
