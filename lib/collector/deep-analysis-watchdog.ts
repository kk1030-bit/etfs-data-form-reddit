import {
  ACTIVE_STATUSES,
  GitHubRequestError,
  githubRequest,
  nextSchedulerCheckAt,
} from './scheduler-watchdog.ts';

const DAY_MS = 86_400_000;
const RETRY_MS = 30 * 60_000;
const LEASE_MS = 90_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export type DeepSchedulerCheck = {
  day: string;
  checkedAt: string;
  status:
    | 'waiting'
    | 'dispatched'
    | 'running'
    | 'completed'
    | 'failed'
    | 'unconfigured'
    | 'exhausted';
  attempts: number;
  lastDispatchAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
};
type CheckRow = {
  day: string;
  checked_at_utc: string;
  status: DeepSchedulerCheck['status'];
  attempts: number;
  last_dispatch_at_utc: string | null;
  next_check_at_utc: string | null;
  error: string | null;
};
type RunRow = { status: string; started_at_utc: string };

const present = (row: CheckRow): DeepSchedulerCheck => ({
  day: row.day,
  checkedAt: row.checked_at_utc,
  status: row.status,
  attempts: row.attempts,
  lastDispatchAt: row.last_dispatch_at_utc,
  nextCheckAt: row.next_check_at_utc,
  error: row.error,
});

function validEvent(scheduled: number, now: number, day: string): boolean {
  return (
    Number.isFinite(scheduled) &&
    Number.isFinite(now) &&
    scheduled <= now + 30_000 &&
    now - scheduled <= 5 * 60_000 &&
    iso(scheduled).slice(0, 10) === day &&
    iso(now).slice(0, 10) === day
  );
}

/** Repairs only a missing daily run. Never clears a run or resets source/AI budgets. */
export async function ensureDeepAnalysis(
  env: { DB: D1Database; GITHUB_ACTIONS_TOKEN?: string },
  scheduledAtMs: number,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<DeepSchedulerCheck> {
  const now = clock();
  const day = iso(now).slice(0, 10);
  const due = Math.floor(now / DAY_MS) * DAY_MS + 50 * 60_000;
  const fallback: DeepSchedulerCheck = {
    day,
    checkedAt: iso(now),
    status: 'failed',
    attempts: 0,
    lastDispatchAt: null,
    nextCheckAt: nextSchedulerCheckAt(now),
    error: 'stale_schedule',
  };
  if (!validEvent(scheduledAtMs, now, day)) return fallback;
  let lastCheck = fallback;
  let lease: string | null = null;
  const readCheck = async () => {
    const row = await env.DB.prepare(
      'SELECT * FROM deep_analysis_scheduler_checks WHERE day = ?1',
    )
      .bind(day)
      .first<CheckRow>();
    if (!row) throw new Error('deep_scheduler_check_missing');
    lastCheck = present(row);
    return lastCheck;
  };
  const readRun = () =>
    env.DB.prepare(
      'SELECT status, started_at_utc FROM deep_analysis_runs WHERE day = ?1',
    )
      .bind(day)
      .first<RunRow>();
  const finish = async (
    status: DeepSchedulerCheck['status'],
    error: string | null = null,
  ) => {
    const finished = clock();
    await env.DB.prepare(`UPDATE deep_analysis_scheduler_checks SET checked_at_utc = ?3,
      status = ?4, next_check_at_utc = ?5, error = ?6, lease_token = NULL, lease_until_utc = NULL
      WHERE day = ?1 AND lease_token = ?2`)
      .bind(
        day,
        lease,
        iso(finished),
        status,
        nextSchedulerCheckAt(finished),
        error,
      )
      .run();
    return readCheck();
  };
  const finishRun = (run: RunRow) => {
    // Even a failed/partial daily claim suppresses dispatch: rerunning cannot
    // recover it safely without a separate, budget-aware resume mechanism.
    if (run.status === 'completed') return finish('completed');
    if (run.status === 'partial') return finish('failed', 'deep_run_partial');
    if (run.status === 'failed') return finish('failed', 'deep_run_failed');
    if (!['collecting', 'processing'].includes(run.status))
      return finish('failed', 'deep_run_unknown_state');
    const started = Date.parse(run.started_at_utc);
    if (
      !Number.isFinite(started) ||
      started > clock() ||
      clock() - started > RUN_TIMEOUT_MS
    )
      return finish('failed', 'deep_run_stalled');
    return finish('running');
  };

  try {
    await env.DB.prepare(`INSERT INTO deep_analysis_scheduler_checks
      (day, checked_at_utc, status, next_check_at_utc) VALUES (?1, ?2, 'waiting', ?3)
      ON CONFLICT(day) DO NOTHING`)
      .bind(day, iso(now), nextSchedulerCheckAt(now))
      .run();
    await env.DB.prepare(
      'DELETE FROM deep_analysis_scheduler_checks WHERE day < ?1',
    )
      .bind(iso(now - 7 * DAY_MS).slice(0, 10))
      .run();
    const token = crypto.randomUUID();
    const lock =
      await env.DB.prepare(`UPDATE deep_analysis_scheduler_checks SET lease_token = ?2,
      lease_until_utc = ?3, checked_at_utc = ?4 WHERE day = ?1
      AND (lease_until_utc IS NULL OR lease_until_utc <= ?4)`)
        .bind(day, token, iso(now + LEASE_MS), iso(now))
        .run();
    if (!Number(lock.meta.changes ?? 0)) return await readCheck();
    lease = token;
    const run = await readRun();
    if (run) return await finishRun(run);
    if (now < due) return await finish('waiting');
    if (!env.GITHUB_ACTIONS_TOKEN?.trim())
      return await finish('unconfigured', 'github_actions_token_missing');
    const check = await readCheck();
    if (
      check.lastDispatchAt &&
      now - Date.parse(check.lastDispatchAt) < RETRY_MS
    )
      return await finish(
        check.status === 'failed' ? 'failed' : 'dispatched',
        check.error,
      );

    const checks = await Promise.allSettled(
      ACTIVE_STATUSES.map((status) =>
        githubRequest(
          env.GITHUB_ACTIONS_TOKEN!,
          fetcher,
          'runs',
          status,
          'deep',
        ),
      ),
    );
    for (const check of checks)
      if (check.status === 'rejected') throw check.reason;
    if (checks.some((check) => check.status === 'fulfilled' && check.value))
      return await finish('running');
    if (check.attempts >= 2)
      return await finish('exhausted', 'daily_attempt_limit');
    const dispatchAt = clock();
    if (!validEvent(scheduledAtMs, dispatchAt, day))
      return await finish('failed', 'stale_schedule');
    // Reserve before sending, including ambiguous HTTP/timeouts. The daily
    // claim is rechecked atomically to protect a concurrent normal/manual run.
    const reservation =
      await env.DB.prepare(`UPDATE deep_analysis_scheduler_checks
      SET attempts = attempts + 1, last_dispatch_at_utc = ?3,
      status = 'failed', error = 'github_dispatch_outcome_unknown'
      WHERE day = ?1 AND lease_token = ?2 AND lease_until_utc > ?3
      AND attempts < 2 AND (last_dispatch_at_utc IS NULL OR last_dispatch_at_utc <= ?4)
      AND NOT EXISTS (SELECT 1 FROM deep_analysis_runs WHERE day = ?1)`)
        .bind(day, token, iso(dispatchAt), iso(dispatchAt - RETRY_MS))
        .run();
    if (!Number(reservation.meta.changes ?? 0)) {
      const changed = await readRun();
      if (changed) return await finishRun(changed);
      const current = await readCheck();
      return await finish(
        current.attempts >= 2 ? 'exhausted' : 'waiting',
        current.attempts >= 2 ? 'daily_attempt_limit' : null,
      );
    }
    await githubRequest(
      env.GITHUB_ACTIONS_TOKEN,
      fetcher,
      'dispatch',
      undefined,
      'deep',
    );
    return await finish('dispatched');
  } catch (error) {
    const code =
      error instanceof GitHubRequestError
        ? error.code
        : 'deep_scheduler_check_failed';
    if (lease) {
      try {
        return await finish('failed', code);
      } catch {
        /* Fail closed if D1 is unavailable. */
      }
    }
    return { ...lastCheck, status: 'failed', error: code };
  }
}
