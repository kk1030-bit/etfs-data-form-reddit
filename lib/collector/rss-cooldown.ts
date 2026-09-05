import { RedditRssError } from './reddit-rss.ts';

const HOUR_MS = 3_600_000;
const LEASE_MS = 6 * 60_000;

export type RssSourceState = {
  source: string;
  consecutive_429: number;
  cooldown_until_utc: string | null;
  last_attempt_at_utc: string | null;
  last_error: string | null;
  lease_token: string | null;
  lease_until_utc: string | null;
};

export class RssDeferredError extends Error {
  readonly retryAtUtc: string;
  readonly reason: 'rate_limited' | 'in_flight';
  constructor(
    retryAtUtc: string,
    reason: 'rate_limited' | 'in_flight' = 'rate_limited',
    source = 'reddit-rss',
  ) {
    super(
      reason === 'rate_limited'
        ? `${source === 'arctic-shift' ? 'Arctic Shift' : 'Reddit RSS'} rate limited`
        : `${source === 'arctic-shift' ? 'Arctic Shift' : 'Reddit RSS'} request already in progress`,
    );
    this.name = 'RssDeferredError';
    this.retryAtUtc = retryAtUtc;
    this.reason = reason;
  }
}

export function cooldownDeadline(
  nowMs: number,
  consecutive429: number,
  retryAfter?: string,
): string {
  const exponent = Math.min(5, Math.max(0, consecutive429 - 1));
  const backoffMs = Math.min(24, 2 ** exponent) * HOUR_MS;
  const value = retryAfter?.trim();
  let requestedMs = Number.NaN;
  if (value && /^\d+(?:\.\d+)?$/.test(value)) {
    requestedMs = nowMs + Number(value) * 1_000;
  } else if (value && /[A-Za-z]{3},?\s/.test(value)) {
    requestedMs = Date.parse(value);
  }
  // Invalid/overflowing headers must not break the job. A valid server deadline
  // longer than our own 24-hour maximum is still respected.
  const serverMs =
    Number.isFinite(requestedMs) && requestedMs <= 8.64e15 ? requestedMs : 0;
  return new Date(Math.max(nowMs + backoffMs, serverMs)).toISOString();
}

export function nextHourlyCheck(deadline: string | null): string | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline);
  return Number.isFinite(ms)
    ? new Date(Math.ceil(ms / HOUR_MS) * HOUR_MS).toISOString()
    : null;
}

export async function readRssSourceState(
  db: D1Database,
  source = 'reddit-rss',
): Promise<RssSourceState | null> {
  const state = await db
    .prepare('SELECT * FROM reddit_source_state WHERE source = ?1')
    .bind(source)
    .first<RssSourceState>();
  if (state) return state;
  if (source !== 'reddit-rss') return null;

  // Upgrade safely from existing failures without firing another request. This
  // is read-only until an hourly job persists the initial state below.
  const history = await db
    .prepare(
      `SELECT status, error, completed_at_utc, started_at_utc FROM hourly_runs
     WHERE source_mode = 'rss-preview' AND status IN ('failed', 'completed')
     ORDER BY started_at_utc DESC LIMIT 32`,
    )
    .all<{
      status: string;
      error: string | null;
      completed_at_utc: string | null;
      started_at_utc: string;
    }>();
  let count = 0;
  for (const row of history.results ?? []) {
    if (
      row.status !== 'failed' ||
      !row.error?.startsWith('Reddit RSS rate limited')
    )
      break;
    count += 1;
  }
  const latest = history.results?.[0];
  if (!count || !latest) return null;
  const failedAt = Date.parse(latest.completed_at_utc ?? latest.started_at_utc);
  const retryAfter = latest.error?.match(/; retry-after=(.+)$/)?.[1];
  return {
    source,
    consecutive_429: count,
    cooldown_until_utc: cooldownDeadline(failedAt, count, retryAfter),
    last_attempt_at_utc: latest.started_at_utc,
    last_error: latest.error,
    lease_token: null,
    lease_until_utc: null,
  };
}

export async function withRssCooldown<T>(
  db: D1Database,
  collect: () => Promise<T>,
  now: () => number = Date.now,
  source = 'reddit-rss',
): Promise<T> {
  const initial = await readRssSourceState(db, source);
  await db
    .prepare(
      `INSERT INTO reddit_source_state
       (source, consecutive_429, cooldown_until_utc, last_attempt_at_utc, last_error)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(source) DO NOTHING`,
    )
    .bind(
      source,
      initial?.consecutive_429 ?? 0,
      initial?.cooldown_until_utc ?? null,
      initial?.last_attempt_at_utc ?? null,
      initial?.last_error ?? null,
    )
    .run();

  const token = crypto.randomUUID();
  const nowMs = now();
  const claimed = await db
    .prepare(
      `UPDATE reddit_source_state SET lease_token = ?1, lease_until_utc = ?2, last_attempt_at_utc = ?3
     WHERE source = ?4 AND (cooldown_until_utc IS NULL OR cooldown_until_utc <= ?3)
       AND (lease_until_utc IS NULL OR lease_until_utc <= ?3)`,
    )
    .bind(
      token,
      new Date(nowMs + LEASE_MS).toISOString(),
      new Date(nowMs).toISOString(),
      source,
    )
    .run();
  const state = await readRssSourceState(db, source);
  if (!Number(claimed.meta.changes)) {
    const cooling =
      state?.cooldown_until_utc && Date.parse(state.cooldown_until_utc) > nowMs;
    throw new RssDeferredError(
      (cooling ? state.cooldown_until_utc : state?.lease_until_utc) ??
        new Date(nowMs + LEASE_MS).toISOString(),
      cooling ? 'rate_limited' : 'in_flight',
      source,
    );
  }
  try {
    const result = await collect();
    await db
      .prepare(
        `UPDATE reddit_source_state SET consecutive_429 = 0, cooldown_until_utc = NULL,
         last_error = NULL, lease_token = NULL, lease_until_utc = NULL
       WHERE source = ?1 AND lease_token = ?2`,
      )
      .bind(source, token)
      .run();
    return result;
  } catch (error) {
    if (error instanceof RedditRssError && error.status === 429) {
      const count = Number(state?.consecutive_429 ?? 0) + 1;
      const deadline = cooldownDeadline(now(), count, error.retryAfter);
      await db
        .prepare(
          `UPDATE reddit_source_state SET consecutive_429 = ?1, cooldown_until_utc = ?2,
           last_error = ?3, lease_token = NULL, lease_until_utc = NULL
         WHERE source = ?4 AND lease_token = ?5`,
        )
        .bind(count, deadline, error.message.slice(0, 2_000), source, token)
        .run();
      throw new RssDeferredError(deadline, 'rate_limited', source);
    }
    await db
      .prepare(
        `UPDATE reddit_source_state SET lease_token = NULL, lease_until_utc = NULL, last_error = ?1
       WHERE source = ?2 AND lease_token = ?3`,
      )
      .bind(
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : 'RSS request failed',
        source,
        token,
      )
      .run();
    throw error;
  }
}
