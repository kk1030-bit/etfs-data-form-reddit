import assert from 'node:assert/strict';
import test from 'node:test';
import { schedulerStatus } from '../lib/collector/scheduler-status.ts';
import type { CollectionAttempt } from '../lib/collector/collection-status.ts';
import type { SchedulerCheck } from '../lib/collector/scheduler-watchdog.ts';

const BASE = Date.parse('2026-09-07T08:00:00.000Z');
const iso = (time: number) => new Date(time).toISOString();
const check = (overrides: Partial<SchedulerCheck> = {}): SchedulerCheck => ({
  logicalHour: iso(BASE),
  checkedAt: iso(BASE),
  status: 'waiting',
  attempts: 0,
  lastDispatchAt: null,
  nextCheckAt: iso(BASE + 25 * 60_000),
  error: null,
  ...overrides,
});
const attempt = (
  overrides: Partial<CollectionAttempt> = {},
): CollectionAttempt => ({
  logicalHour: iso(BASE),
  startedAt: iso(BASE + 10 * 60_000),
  completedAt: null,
  status: 'running',
  stage: 'source',
  error: null,
  upstreamStatus: null,
  retryAt: null,
  ...overrides,
});
const status = (
  overrides: Partial<Parameters<typeof schedulerStatus>[0]> = {},
) =>
  schedulerStatus({
    nowMs: BASE + 25 * 60_000,
    lastCompletedHour: iso(BASE - 3_600_000),
    latestAttempt: null,
    latestCheck: check(),
    ...overrides,
  });

void test('the exact :25 deadline requires the current logical hour', () => {
  const before = status({ nowMs: BASE + 25 * 60_000 - 1 });
  assert.equal(before.expectedHour, iso(BASE - 3_600_000));
  assert.equal(before.isOverdue, false);
  assert.equal(before.currentHourCompleted, false);
  const at = status();
  assert.equal(at.expectedHour, iso(BASE));
  assert.equal(at.deadlineAt, iso(BASE + 25 * 60_000));
  assert.equal(at.isOverdue, true);
  assert.match(at.message, /漏跑／待完成/);
});
void test('the grace period never hides a missing previous hour or missing history', () => {
  for (const lastCompletedHour of [null, iso(BASE - 2 * 3_600_000)]) {
    const result = status({ nowMs: BASE + 13 * 60_000, lastCompletedHour });
    assert.equal(result.expectedHour, iso(BASE - 3_600_000));
    assert.equal(result.isOverdue, true);
  }
});
void test('recent completion of an old logical hour does not satisfy this hour', () => {
  const result = status({
    latestAttempt: attempt({
      logicalHour: iso(BASE - 3_600_000),
      startedAt: iso(BASE + 20 * 60_000),
      completedAt: iso(BASE + 24 * 60_000),
      status: 'completed',
      stage: 'completed',
    }),
    latestCheck: check({
      logicalHour: iso(BASE - 3_600_000),
      checkedAt: iso(BASE - 10 * 60_000),
      status: 'completed',
    }),
  });
  assert.equal(result.currentHourCompleted, false);
  assert.equal(result.isOverdue, true);
  assert.equal(result.checkStale, true);
});
void test('waiting, dispatched, running and a completed check are not dataset completion', () => {
  for (const checkStatus of [
    'waiting',
    'dispatched',
    'running',
    'completed',
  ] as const) {
    const result = status({ latestCheck: check({ status: checkStatus }) });
    assert.equal(result.currentHourCompleted, false, checkStatus);
    assert.equal(result.isOverdue, true, checkStatus);
  }
  const dispatched = status({ latestCheck: check({ status: 'dispatched' }) });
  assert.match(dispatched.message, /已补触发/);
  assert.match(dispatched.checkMessage, /尚不代表采集成功/);
});
void test('actual running attempts remain pending both before and after the deadline', () => {
  const before = status({
    nowMs: BASE + 15 * 60_000,
    latestAttempt: attempt(),
  });
  assert.equal(before.isOverdue, false);
  assert.equal(before.currentHourCompleted, false);
  assert.match(before.message, /正在排队或执行/);
  const after = status({ latestAttempt: attempt() });
  assert.equal(after.isOverdue, true);
  assert.match(after.message, /正在排队或执行/);
  assert.doesNotMatch(
    status({ latestAttempt: attempt({ logicalHour: iso(BASE - 3_600_000) }) })
      .message,
    /正在排队或执行/,
  );
});
void test('actual current-hour completion satisfies freshness before the next check', () => {
  const result = status({ lastCompletedHour: iso(BASE) });
  assert.equal(result.currentHourCompleted, true);
  assert.equal(result.isOverdue, false);
  assert.equal(result.needsAttention, false);
  assert.equal(result.message, '本小时采集已完成。');
  assert.equal(result.configured, null);
});
void test('missing/unreadable checks remain visible independently of fresh data', () => {
  const missing = status({ lastCompletedHour: iso(BASE), latestCheck: null });
  assert.equal(missing.isOverdue, false);
  assert.equal(missing.checkUnavailable, true);
  assert.equal(missing.needsAttention, true);
  assert.match(missing.checkMessage, /尚无 Cloudflare/);
  const failedRead = status({
    lastCompletedHour: iso(BASE),
    latestCheck: null,
    checkReadFailed: true,
  });
  assert.equal(failedRead.currentHourCompleted, true);
  assert.match(failedRead.checkMessage, /已保留现有榜单/);
});
void test('unconfigured explicitly identifies the dedicated token', () => {
  const result = status({
    lastCompletedHour: iso(BASE),
    latestCheck: check({ status: 'unconfigured' }),
  });
  assert.equal(result.configured, false);
  assert.equal(result.currentHourCompleted, true);
  assert.equal(result.isOverdue, false);
  assert.equal(result.needsAttention, true);
  assert.match(result.checkMessage, /专用 GitHub Actions token/);
});
void test('failed/exhausted checks need attention independently of data freshness', () => {
  for (const checkStatus of ['failed', 'exhausted'] as const) {
    const result = status({
      lastCompletedHour: iso(BASE),
      latestCheck: check({ status: checkStatus }),
    });
    assert.equal(result.isOverdue, false);
    assert.equal(result.needsAttention, true);
  }
});
void test('cooldown never turns a missing hour into a completed or synthetic attempt', () => {
  const result = status({
    latestCheck: check({ status: 'cooldown' }),
    cooldownUntil: iso(BASE + 3_600_000),
  });
  assert.equal(result.isOverdue, true);
  assert.equal(result.currentHourCompleted, false);
  assert.match(result.message, /来源仍在冷却/);
});
void test('next checks use 00/25/50 and normal :10 across hour boundaries', () => {
  for (const [minute, nextMinute] of [
    [0, 25],
    [25, 50],
    [49, 50],
    [50, 60],
    [59, 60],
  ])
    assert.equal(
      status({ nowMs: BASE + minute * 60_000 }).nextCheckAt,
      iso(BASE + nextMinute * 60_000),
    );
  assert.equal(
    status({ nowMs: BASE + 9 * 60_000 }).nextExpectedAt,
    iso(BASE + 10 * 60_000),
  );
  assert.equal(
    status({ nowMs: BASE + 10 * 60_000 }).nextExpectedAt,
    iso(BASE + 70 * 60_000),
  );
  const rollover = status({ nowMs: Date.parse('2026-09-07T23:59:00.000Z') });
  assert.equal(rollover.nextCheckAt, '2026-09-08T00:00:00.000Z');
  assert.equal(rollover.nextExpectedAt, '2026-09-08T00:10:00.000Z');
});
void test('future or malformed logical hours cannot claim completion', () => {
  for (const lastCompletedHour of [iso(BASE + 3_600_000), 'invalid']) {
    assert.equal(status({ lastCompletedHour }).currentHourCompleted, false);
    assert.equal(status({ lastCompletedHour }).isOverdue, true);
  }
});
void test('same-hour check goes stale after the next scheduled check and delivery grace', () => {
  const latestCheck = check({ checkedAt: iso(BASE + 25 * 60_000) });
  assert.equal(
    status({ nowMs: BASE + 54 * 60_000, latestCheck }).checkStale,
    false,
  );
  const stale = status({
    nowMs: BASE + 55 * 60_000,
    lastCompletedHour: iso(BASE),
    latestCheck,
  });
  assert.equal(stale.checkStale, true);
  assert.equal(stale.needsAttention, true);
  assert.equal(stale.isOverdue, false);
  assert.equal(
    status({
      nowMs: BASE + 55 * 60_000,
      latestCheck: check({ checkedAt: iso(BASE + 50 * 60_000) }),
    }).checkStale,
    false,
  );
});
