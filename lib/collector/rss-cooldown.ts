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
  execution_context?: string | null;
  cooldown_origin?: string | null;
};

declare const __COLLECTOR_BUILD_SHA__: string;
export function workerArcticContext(): string {
  return `cloudflare-worker:${typeof __COLLECTOR_BUILD_SHA__ === 'undefined' ? 'local-development' : __COLLECTOR_BUILD_SHA__}`;
}

export async function prepareArcticContext(
  db: D1Database,
  context: string,
  nowMs = Date.now(),
): Promise<RssSourceState> {
  const at = new Date(nowMs).toISOString();
  await db.batch([
    db
      .prepare(`INSERT INTO reddit_source_state (source, execution_context)
      VALUES ('arctic-shift', ?1) ON CONFLICT(source) DO NOTHING`)
      .bind(context),
    db
      .prepare(`UPDATE reddit_source_state SET execution_context = ?1, consecutive_429 = 0,
      cooldown_until_utc = CASE WHEN cooldown_origin = 'fallback' THEN NULL ELSE cooldown_until_utc END,
      cooldown_origin = CASE WHEN cooldown_origin = 'fallback' THEN NULL ELSE cooldown_origin END
      WHERE source = 'arctic-shift' AND execution_context IS NOT ?1
      AND (lease_until_utc IS NULL OR lease_until_utc <= ?2)`)
      .bind(context, at),
  ]);
  const state = (await readRssSourceState(db, 'arctic-shift'))!;
  if (state.execution_context !== context)
    throw new RssDeferredError(
      state.lease_until_utc ?? at,
      'in_flight',
      'arctic-shift',
    );
  return state;
}

// Explicit operator action only. Keep attempt history, posts and other sources.
export async function resetArcticCooldown(db: D1Database, nowMs = Date.now()) {
  const before = await readRssSourceState(db, 'arctic-shift');
  const at = new Date(nowMs).toISOString();
  if (before?.lease_until_utc && before.lease_until_utc > at)
    throw new RssDeferredError(
      before.lease_until_utc,
      'in_flight',
      'arctic-shift',
    );
  const result = await db
    .prepare(`UPDATE reddit_source_state SET consecutive_429 = 0,
    cooldown_until_utc = NULL, cooldown_origin = NULL, last_error = NULL
    WHERE source = 'arctic-shift' AND (lease_until_utc IS NULL OR lease_until_utc <= ?1)`)
    .bind(at)
    .run();
  if (before && !Number(result.meta.changes))
    throw new RssDeferredError(at, 'in_flight', 'arctic-shift');
  return { before, after: await readRssSourceState(db, 'arctic-shift') };
}

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

function serverCooldownMs(
  nowMs: number,
  retryAfter?: string,
): number | undefined {
  const value = retryAfter?.trim();
  let requestedMs = Number.NaN;
  if (value && /^\d+(?:\.\d+)?$/.test(value)) {
    requestedMs = nowMs + Number(value) * 1_000;
  } else if (value && /[A-Za-z]{3},?\s/.test(value)) {
    requestedMs = Date.parse(value);
  }
  // Invalid/overflowing headers must not break the job. A valid server deadline
  // longer than our own 24-hour maximum is still respected.
  return Number.isFinite(requestedMs) &&
    requestedMs >= nowMs &&
    requestedMs <= 8.64e15
    ? requestedMs
    : undefined;
}

export function cooldownDeadline(
  nowMs: number,
  consecutive429: number,
  retryAfter?: string,
  preferServer = false,
): string {
  const exponent = Math.min(5, Math.max(0, consecutive429 - 1));
  const backoffMs = Math.min(24, 2 ** exponent) * HOUR_MS;
  const serverMs = serverCooldownMs(nowMs, retryAfter);
  if (preferServer && serverMs !== undefined)
    return new Date(serverMs).toISOString();
  return new Date(Math.max(nowMs + backoffMs, serverMs ?? 0)).toISOString();
}

export function nextHourlyCheck(
  deadline: string | null,
  minuteOffset = 0,
): string | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline);
  return Number.isFinite(ms)
    ? new Date(
        Math.ceil((ms - minuteOffset * 60000) / HOUR_MS) * HOUR_MS +
          minuteOffset * 60000,
      ).toISOString()
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
  expectedContext?: string,
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
       AND (lease_until_utc IS NULL OR lease_until_utc <= ?3)
       AND (?5 IS NULL OR execution_context = ?5)`,
    )
    .bind(
      token,
      new Date(nowMs + LEASE_MS).toISOString(),
      new Date(nowMs).toISOString(),
      source,
      expectedContext ?? null,
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
         last_error = NULL, lease_token = NULL, lease_until_utc = NULL, cooldown_origin = NULL
       WHERE source = ?1 AND lease_token = ?2`,
      )
      .bind(source, token)
      .run();
    return result;
  } catch (error) {
    if (
      error instanceof RedditRssError &&
      (error.status === 429 ||
        (error.status === 503 && Boolean(error.retryAfter)))
    ) {
      const count = Number(state?.consecutive_429 ?? 0) + 1;
      const failedAt = now();
      const deadline = cooldownDeadline(
        failedAt,
        count,
        error.retryAfter,
        source === 'arctic-shift',
      );
      const origin =
        source === 'arctic-shift' &&
        serverCooldownMs(failedAt, error.retryAfter) !== undefined
          ? 'server'
          : 'fallback';
      await db
        .prepare(
          `UPDATE reddit_source_state SET consecutive_429 = ?1, cooldown_until_utc = ?2,
           last_error = ?3, lease_token = NULL, lease_until_utc = NULL, cooldown_origin = ?6
         WHERE source = ?4 AND lease_token = ?5`,
        )
        .bind(
          count,
          deadline,
          error.message.slice(0, 2_000),
          source,
          token,
          origin,
        )
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
