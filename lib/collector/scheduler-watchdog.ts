import { logicalHourIso } from './core.ts';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const RETRY_MS = 20 * MINUTE_MS;
const LEASE_MS = 90_000;
const MAX_EVENT_LAG_MS = 5 * MINUTE_MS;
const GITHUB_TIMEOUT_MS = 8_000;
const WORKFLOW_URL =
  'https://api.github.com/repos/kk1030-bit/etfs-data-form-reddit/actions/workflows/title-index.yml';
const ACTIVE_STATUSES = [
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
] as const;

export type SchedulerCheck = {
  logicalHour: string;
  checkedAt: string;
  status:
    | 'waiting'
    | 'dispatched'
    | 'running'
    | 'completed'
    | 'cooldown'
    | 'failed'
    | 'unconfigured'
    | 'exhausted';
  attempts: number;
  lastDispatchAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
};

type CheckRow = {
  logical_hour_utc: string;
  checked_at_utc: string;
  status: SchedulerCheck['status'];
  attempts: number;
  last_dispatch_at_utc: string | null;
  next_check_at_utc: string | null;
  error: string | null;
  lease_token: string | null;
  lease_until_utc: string | null;
};

function presentCheck(row: CheckRow): SchedulerCheck {
  return {
    logicalHour: row.logical_hour_utc,
    checkedAt: row.checked_at_utc,
    status: row.status,
    attempts: row.attempts,
    lastDispatchAt: row.last_dispatch_at_utc,
    nextCheckAt: row.next_check_at_utc,
    error: row.error,
  };
}

export async function readSchedulerCheck(
  db: D1Database,
): Promise<SchedulerCheck | null> {
  const row = await db
    .prepare(
      'SELECT * FROM scheduler_checks ORDER BY logical_hour_utc DESC LIMIT 1',
    )
    .first<CheckRow>();
  return row ? presentCheck(row) : null;
}

export function nextSchedulerCheckAt(nowMs: number): string {
  const hourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const minute = (nowMs - hourMs) / MINUTE_MS;
  return new Date(
    hourMs + (minute < 25 ? 25 : minute < 50 ? 50 : 60) * MINUTE_MS,
  ).toISOString();
}

function validEvent(scheduledAtMs: number, nowMs: number): boolean {
  return (
    Number.isFinite(scheduledAtMs) &&
    Number.isFinite(nowMs) &&
    Math.floor(scheduledAtMs / HOUR_MS) === Math.floor(nowMs / HOUR_MS) &&
    scheduledAtMs <= nowMs + 30_000 &&
    nowMs - scheduledAtMs <= MAX_EVENT_LAG_MS
  );
}

// The same predicates protect both the initial read and the atomic reservation.
// Collection's own job lease considers running attempts stale after 20 minutes.
const COLLECTION_BARRIERS = `
  SELECT 'completed' AS status, 1 AS priority FROM job_runs
    WHERE job_type = 'hourly' AND logical_time_utc = ?1 AND status = 'completed'
  UNION ALL SELECT 'completed', 1 FROM hourly_runs
    WHERE logical_hour_utc = ?1 AND status = 'completed'
  UNION ALL SELECT 'cooldown', 2 FROM reddit_source_state
    WHERE source = 'arctic-shift' AND cooldown_until_utc > ?2
  UNION ALL SELECT 'cooldown', 2 FROM hourly_runs
    WHERE logical_hour_utc = ?1 AND status IN ('cooldown', 'deferred') AND retry_at_utc > ?2
  UNION ALL SELECT 'running', 3 FROM reddit_source_state
    WHERE source = 'arctic-shift' AND lease_until_utc > ?2
  UNION ALL SELECT 'running', 3 FROM job_runs
    WHERE job_type = 'hourly' AND logical_time_utc = ?1 AND status = 'running' AND started_at_utc > ?3
  UNION ALL SELECT 'running', 3 FROM hourly_runs
    WHERE logical_hour_utc = ?1 AND status = 'running' AND started_at_utc > ?3
`;

async function collectionBarrier(db: D1Database, hour: string, nowMs: number) {
  return db
    .prepare(
      `SELECT status FROM (${COLLECTION_BARRIERS}) ORDER BY priority LIMIT 1`,
    )
    .bind(
      hour,
      new Date(nowMs).toISOString(),
      new Date(nowMs - RETRY_MS).toISOString(),
    )
    .first<{ status: 'completed' | 'cooldown' | 'running' }>();
}

class GitHubRequestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function githubRequest(
  token: string,
  fetcher: typeof fetch,
  operation: 'runs' | 'dispatch',
  status?: (typeof ACTIVE_STATUSES)[number],
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prefix = `github_${operation}`;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new GitHubRequestError(`${prefix}_timeout`));
      controller.abort();
    }, GITHUB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetcher(
          operation === 'dispatch'
            ? `${WORKFLOW_URL}/dispatches`
            : `${WORKFLOW_URL}/runs?status=${status}&per_page=1`,
          {
            method: operation === 'dispatch' ? 'POST' : 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2026-03-10',
              'User-Agent':
                'etfs-hourly-watchdog (github.com/kk1030-bit/etfs-data-form-reddit)',
              ...(operation === 'dispatch'
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
            ...(operation === 'dispatch'
              ? { body: JSON.stringify({ ref: 'main' }) }
              : {}),
          },
        );
        if (operation === 'dispatch') {
          if (response.status !== 200 && response.status !== 204)
            throw new GitHubRequestError(`${prefix}_http_${response.status}`);
          // Both current 200 (with run_url) and legacy 204 mean accepted only.
          // Do not follow, persist, or log response URLs or response bodies.
          return true;
        }
        if (response.status !== 200)
          throw new GitHubRequestError(`${prefix}_http_${response.status}`);
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new GitHubRequestError(`${prefix}_invalid_response`);
        }
        if (
          !body ||
          typeof body !== 'object' ||
          !('total_count' in body) ||
          !Number.isSafeInteger(body.total_count) ||
          (body.total_count as number) < 0 ||
          !('workflow_runs' in body) ||
          !Array.isArray(body.workflow_runs) ||
          ((body.total_count as number) === 0 &&
            body.workflow_runs.length !== 0) ||
          ((body.total_count as number) > 0 && body.workflow_runs.length === 0)
        )
          throw new GitHubRequestError(`${prefix}_invalid_response`);
        // Each request filters one active status on this exact workflow. A run
        // on any branch may hold its shared concurrency group, so do not filter main.
        return (body.total_count as number) > 0;
      })(),
    ]);
  } catch (error) {
    if (error instanceof GitHubRequestError) throw error;
    const timedOut =
      error instanceof Error &&
      ['AbortError', 'TimeoutError'].includes(error.name);
    throw new GitHubRequestError(
      `${prefix}_${timedOut ? 'timeout' : 'network_error'}`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function ensureHourlyCollection(
  env: { DB: D1Database; GITHUB_ACTIONS_TOKEN?: string },
  scheduledAtMs: number,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<SchedulerCheck> {
  const nowMs = clock();
  const at = new Date(nowMs).toISOString();
  const hour = logicalHourIso(nowMs);
  const nextCheck = nextSchedulerCheckAt(nowMs);
  if (!validEvent(scheduledAtMs, nowMs)) {
    // Stale/future deliveries neither dispatch nor overwrite a current check.
    return {
      logicalHour: hour,
      checkedAt: at,
      status: 'failed',
      attempts: 0,
      lastDispatchAt: null,
      nextCheckAt: nextCheck,
      error: 'stale_schedule',
    };
  }
  await env.DB.prepare(`INSERT INTO scheduler_checks
    (logical_hour_utc, checked_at_utc, status, next_check_at_utc)
    VALUES (?1, ?2, 'waiting', ?3) ON CONFLICT(logical_hour_utc) DO NOTHING`)
    .bind(hour, at, nextCheck)
    .run();
  await env.DB.prepare(
    'DELETE FROM scheduler_checks WHERE logical_hour_utc < ?1',
  )
    .bind(new Date(nowMs - 7 * 24 * HOUR_MS).toISOString())
    .run();

  const readHour = async () => {
    const row = await env.DB.prepare(
      'SELECT * FROM scheduler_checks WHERE logical_hour_utc = ?1',
    )
      .bind(hour)
      .first<CheckRow>();
    if (!row) throw new Error('scheduler_check_missing');
    return row;
  };
  const leaseToken = crypto.randomUUID();
  const lock =
    await env.DB.prepare(`UPDATE scheduler_checks SET lease_token = ?2,
    lease_until_utc = ?3, checked_at_utc = ?4
    WHERE logical_hour_utc = ?1 AND (lease_until_utc IS NULL OR lease_until_utc <= ?4)`)
      .bind(hour, leaseToken, new Date(nowMs + LEASE_MS).toISOString(), at)
      .run();
  if (!Number(lock.meta.changes ?? 0)) {
    const check = presentCheck(await readHour());
    return {
      ...check,
      status: check.status === 'completed' ? 'completed' : 'running',
    };
  }

  const finish = async (
    status: SchedulerCheck['status'],
    error: string | null = null,
  ) => {
    const finishedMs = clock();
    await env.DB.prepare(`UPDATE scheduler_checks SET checked_at_utc = ?3,
      status = ?4, next_check_at_utc = ?5, error = ?6,
      lease_token = NULL, lease_until_utc = NULL
      WHERE logical_hour_utc = ?1 AND lease_token = ?2`)
      .bind(
        hour,
        leaseToken,
        new Date(finishedMs).toISOString(),
        status,
        nextSchedulerCheckAt(finishedMs),
        error,
      )
      .run();
    return presentCheck(await readHour());
  };

  try {
    const barrier = await collectionBarrier(env.DB, hour, nowMs);
    if (barrier) return await finish(barrier.status);
    if (nowMs - Date.parse(hour) < 25 * MINUTE_MS)
      return await finish('waiting');
    if (!env.GITHUB_ACTIONS_TOKEN?.trim())
      return await finish('unconfigured', 'github_actions_token_missing');
    const row = await readHour();
    if (
      row.last_dispatch_at_utc &&
      nowMs - Date.parse(row.last_dispatch_at_utc) < RETRY_MS
    )
      return await finish(
        row.status === 'failed'
          ? 'failed'
          : row.status === 'running'
            ? 'running'
            : 'dispatched',
        row.error,
      );

    const runChecks = await Promise.allSettled(
      ACTIVE_STATUSES.map((status) =>
        githubRequest(env.GITHUB_ACTIONS_TOKEN!, fetcher, 'runs', status),
      ),
    );
    for (const result of runChecks) {
      if (result.status === 'rejected') throw result.reason;
    }
    if (
      runChecks.some((result) => result.status === 'fulfilled' && result.value)
    )
      return await finish('running');
    // Spending the dispatch budget does not make an accepted/running job fail.
    if (row.attempts >= 2)
      return await finish('exhausted', 'hourly_attempt_limit');

    const dispatchMs = clock();
    if (!validEvent(scheduledAtMs, dispatchMs))
      return await finish('failed', 'stale_schedule');
    // Reserve before sending. A timeout/crash may have reached GitHub, so the
    // attempt and 20-minute delay must survive ambiguous network outcomes.
    const reservation = await env.DB.prepare(`UPDATE scheduler_checks
      SET attempts = attempts + 1, last_dispatch_at_utc = ?2,
          status = 'failed', error = 'github_dispatch_outcome_unknown'
      WHERE logical_hour_utc = ?1 AND lease_token = ?4 AND lease_until_utc > ?2
        AND attempts < 2 AND (last_dispatch_at_utc IS NULL OR last_dispatch_at_utc <= ?3)
        AND NOT EXISTS (SELECT 1 FROM (${COLLECTION_BARRIERS}))`)
      .bind(
        hour,
        new Date(dispatchMs).toISOString(),
        new Date(dispatchMs - RETRY_MS).toISOString(),
        leaseToken,
      )
      .run();
    if (!Number(reservation.meta.changes ?? 0)) {
      const changedBarrier = await collectionBarrier(env.DB, hour, clock());
      if (changedBarrier) return await finish(changedBarrier.status);
      const current = await readHour();
      return await finish(
        current.attempts >= 2 ? 'exhausted' : 'waiting',
        current.attempts >= 2 ? 'hourly_attempt_limit' : null,
      );
    }
    await githubRequest(env.GITHUB_ACTIONS_TOKEN, fetcher, 'dispatch');
    return await finish('dispatched');
  } catch (error) {
    return await finish(
      'failed',
      error instanceof GitHubRequestError
        ? error.code
        : 'scheduler_check_failed',
    );
  }
}
