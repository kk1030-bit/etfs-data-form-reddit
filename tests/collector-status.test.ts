import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cooldownDeadline,
  nextHourlyCheck,
  readRssSourceState,
  RssDeferredError,
  withRssCooldown,
} from '../lib/collector/rss-cooldown.ts';
import { RedditRssError } from '../lib/collector/reddit-rss.ts';
import {
  collectionPipeline,
  presentAttempt,
  rollingWindow,
  type AttemptRow,
} from '../lib/collector/collection-status.ts';
import {
  LATEST_ATTEMPT_SQL,
  RECENT_COUNTS_SQL,
} from '../lib/collector/dashboard-queries.ts';
import { testDb } from './d1-test-db.ts';
import { runHourly } from '../lib/collector/jobs.ts';

const BASE = Date.parse('2026-09-03T08:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

void test('Retry-After accepts seconds and dates, rejects malformed values, and respects longer server deadlines', () => {
  assert.equal(cooldownDeadline(BASE, 1), iso(BASE + 3_600_000));
  assert.equal(cooldownDeadline(BASE, 2), iso(BASE + 7_200_000));
  assert.equal(cooldownDeadline(BASE, 30), iso(BASE + 86_400_000));
  assert.equal(cooldownDeadline(BASE, 1, '7200'), iso(BASE + 7_200_000));
  assert.equal(
    cooldownDeadline(BASE, 1, new Date(BASE + 172_800_000).toUTCString()),
    iso(BASE + 172_800_000),
  );
  for (const value of [
    '0',
    '-100',
    'invalid',
    '9'.repeat(400),
    new Date(BASE - 1_000).toUTCString(),
  ]) {
    assert.equal(cooldownDeadline(BASE, 1, value), iso(BASE + 3_600_000));
  }
  assert.equal(nextHourlyCheck(iso(BASE + 3_601_000)), iso(BASE + 7_200_000));
});

void test('429 survives worker restart, cooldown skips do not fetch/extend, exact expiry retries and success resets', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  let now = BASE;
  let calls = 0;
  const collect = async () => {
    calls += 1;
    throw new RedditRssError('Reddit RSS rate limited', 429);
  };
  await assert.rejects(
    withRssCooldown(fixture.db, collect, () => now),
    RssDeferredError,
  );
  const first = await readRssSourceState(fixture.db);
  assert.equal(first?.consecutive_429, 1);
  now += 60_000;
  // A new wrapper invocation has no shared in-memory state.
  await assert.rejects(
    withRssCooldown(fixture.db, collect, () => now),
    RssDeferredError,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await readRssSourceState(fixture.db), first);
  now = BASE + 3_600_000;
  assert.equal(
    await withRssCooldown(
      fixture.db,
      async () => {
        calls += 1;
        return 'ok';
      },
      () => now,
    ),
    'ok',
  );
  assert.equal(calls, 2);
  const reset = await readRssSourceState(fixture.db);
  assert.equal(reset?.consecutive_429, 0);
  assert.equal(reset?.cooldown_until_utc, null);
  assert.equal(reset?.lease_token, null);
});

void test('global RSS lease prevents concurrent requests and releases after non-429 errors', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  let release!: () => void;
  let entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withRssCooldown(
    fixture.db,
    async () => {
      entered();
      await blocked;
      return 'ok';
    },
    () => BASE,
  );
  await active;
  await assert.rejects(
    withRssCooldown(
      fixture.db,
      async () => assert.fail('duplicate fetch'),
      () => BASE,
    ),
    (error: unknown) =>
      error instanceof RssDeferredError && error.reason === 'in_flight',
  );
  release();
  await first;
  await assert.rejects(
    withRssCooldown(
      fixture.db,
      async () => {
        throw new RedditRssError('Reddit RSS 403', 403);
      },
      () => BASE,
    ),
    /403/,
  );
  assert.equal((await readRssSourceState(fixture.db))?.lease_token, null);
  assert.equal((await readRssSourceState(fixture.db))?.consecutive_429, 0);
});

void test('existing consecutive rate limits bootstrap a persistent cooldown without contacting Reddit', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  for (let index = 0; index < 14; index += 1) {
    const time = iso(BASE - (14 - index) * 3_600_000);
    fixture.sqlite
      .prepare(`INSERT INTO hourly_runs (logical_hour_utc, started_at_utc, completed_at_utc, status, source_mode, error)
      VALUES (?, ?, ?, 'failed', 'rss-preview', 'Reddit RSS rate limited')`)
      .run(time, time, time);
  }
  const state = await readRssSourceState(fixture.db);
  assert.equal(state?.consecutive_429, 14);
  assert.equal(state?.cooldown_until_utc, iso(BASE + 23 * 3_600_000));
  await assert.rejects(
    withRssCooldown(
      fixture.db,
      async () => assert.fail('should remain cool'),
      () => BASE,
    ),
    RssDeferredError,
  );
  assert.equal((await readRssSourceState(fixture.db))?.consecutive_429, 14);
});

const attempt = (overrides: Partial<AttemptRow> = {}): AttemptRow => ({
  logical_hour_utc: iso(BASE),
  started_at_utc: iso(BASE),
  completed_at_utc: iso(BASE),
  status: 'failed',
  stage: 'unknown',
  error: null,
  upstream_status: null,
  retry_at_utc: null,
  ...overrides,
});

void test('status reports exact failure stage, handles historical 429, and does not invent success or activity', () => {
  const historical = presentAttempt(
    attempt({ error: 'Reddit RSS rate limited' }),
    BASE,
  );
  assert.equal(historical?.upstreamStatus, 429);
  assert.deepEqual(
    collectionPipeline(historical, true).map((step) => step.status),
    ['failed', 'not_run', 'not_run', 'not_run', 'not_run'],
  );
  const downstream = presentAttempt(
    attempt({ stage: 'publishing', error: 'D1_ERROR: fail' }),
    BASE,
  );
  assert.deepEqual(
    collectionPipeline(downstream, true).map((step) => step.status),
    ['completed', 'completed', 'completed', 'completed', 'failed'],
  );
  assert.ok(
    collectionPipeline(presentAttempt(attempt(), BASE), true).every(
      (step) => step.status === 'not_run',
    ),
  );
  assert.equal(presentAttempt(null, BASE), null);
  assert.ok(
    collectionPipeline(null, true).every((step) => step.status === 'waiting'),
  );
  const timedOut = presentAttempt(
    attempt({
      status: 'running',
      stage: 'source',
      started_at_utc: iso(BASE - 1_200_000),
    }),
    BASE,
  );
  assert.equal(timedOut?.status, 'failed');
  const completed = presentAttempt(attempt({ status: 'completed' }), BASE);
  assert.equal(
    collectionPipeline(completed, true, 'waiting')[3].status,
    'not_run',
  );
  assert.equal(
    collectionPipeline(completed, true, 'failed')[3].status,
    'failed',
  );
});

void test('rolling counts exclude exact cutoff, future rows, cooldown and failed runs, and expired tracking', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const times = [BASE - 86_400_000, BASE - 3_600_000, BASE, BASE + 3_600_000];
  for (const time of times)
    fixture.sqlite
      .prepare(
        `INSERT INTO hourly_runs (logical_hour_utc, started_at_utc, status) VALUES (?, ?, 'completed')`,
      )
      .run(iso(time), iso(time));
  fixture.sqlite
    .prepare(
      `INSERT INTO hourly_runs (logical_hour_utc, started_at_utc, status) VALUES (?, ?, 'cooldown')`,
    )
    .run(iso(BASE - 7_200_000), iso(BASE - 7_200_000));
  fixture.sqlite
    .prepare(`INSERT INTO reddit_posts (id, reddit_id, subreddit, permalink, title_original, content_hash, created_at_utc, first_seen_at_utc, last_seen_at_utc)
    VALUES ('t3_test', 'test', 'ETFs', 'https://www.reddit.com/r/ETFs/comments/test/', 'ETF', 'hash', ?, ?, ?)`)
    .run(iso(BASE), iso(BASE), iso(BASE));
  for (const [index, time] of times.entries()) {
    fixture.sqlite
      .prepare(
        `INSERT INTO hourly_rankings (logical_hour_utc, rank, post_id, heat_score, components_json) VALUES (?, 1, 't3_test', 50, '{}')`,
      )
      .run(iso(time));
    fixture.sqlite
      .prepare(`INSERT INTO tracking_episodes (id, post_id, started_at_utc, expires_at_utc, last_selected_at_utc, status)
      VALUES (?, 't3_test', ?, ?, ?, 'active')`)
      .run(String(index), iso(time), iso(time + 3_600_000), iso(time));
  }
  const window = rollingWindow(BASE);
  const counts = await fixture.db
    .prepare(RECENT_COUNTS_SQL)
    .bind(window.start, window.end)
    .first<{
      completed_hours: number;
      rank_slots: number;
      unique_posts: number;
      active_tracked: number;
    }>();
  assert.equal(counts?.completed_hours, 2);
  assert.equal(counts?.rank_slots, 2);
  assert.equal(counts?.unique_posts, 1);
  assert.equal(counts?.active_tracked, 1);
  const later = rollingWindow(BASE + 48 * 3_600_000);
  assert.equal(
    (
      await fixture.db
        .prepare(RECENT_COUNTS_SQL)
        .bind(later.start, later.end)
        .first<{ completed_hours: number }>()
    )?.completed_hours,
    0,
  );
  assert.equal(
    fixture.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM hourly_runs WHERE status = 'completed'",
      )
      .get()?.count,
    4,
  );
});

void test('hourly cooldown is recorded without new rankings and never treated as success; OAuth is independent', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const now = Date.now();
  fixture.sqlite
    .prepare(`INSERT INTO reddit_source_state (source, consecutive_429, cooldown_until_utc, last_error)
    VALUES ('reddit-rss', 4, ?, 'Reddit RSS rate limited')`)
    .run(iso(now + 86_400_000));
  const result = await runHourly(
    { DB: fixture.db, REDDIT_SOURCE_MODE: 'rss_preview' },
    now,
  );
  assert.equal(result.status, 'cooldown');
  assert.equal(result.upstreamStatus, 429);
  assert.equal(
    fixture.sqlite.prepare('SELECT status FROM hourly_runs').get()?.status,
    'cooldown',
  );
  assert.equal(
    fixture.sqlite.prepare('SELECT status FROM job_runs').get()?.status,
    'cooldown',
  );
  assert.equal(
    fixture.sqlite
      .prepare('SELECT COUNT(*) AS count FROM hourly_rankings')
      .get()?.count,
    0,
  );
  assert.equal(
    (
      await runHourly(
        { DB: fixture.db, REDDIT_SOURCE_MODE: 'rss_preview' },
        now,
      )
    ).status,
    'skipped',
  );
  // Once the recorded retry deadline has passed, the same hour can re-enter;
  // the independent source cooldown still prevents an actual Reddit request.
  for (const status of ['cooldown', 'deferred']) {
    fixture.sqlite.prepare('UPDATE job_runs SET status = ?').run(status);
    fixture.sqlite
      .prepare('UPDATE hourly_runs SET retry_at_utc = ?')
      .run(iso(now - 1_000));
    assert.equal(
      (
        await runHourly(
          { DB: fixture.db, REDDIT_SOURCE_MODE: 'rss_preview' },
          now,
        )
      ).status,
      'cooldown',
    );
  }
  // OAuth reaches its own credential validation; it is not blocked by RSS cooldown.
  await assert.rejects(
    runHourly({ DB: fixture.db, REDDIT_SOURCE_MODE: 'oauth' }, now + 3_600_000),
    /REDDIT_CLIENT_ID/,
  );
});

void test('latest attempt follows actual start time, including an older logical-hour retry', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  fixture.sqlite
    .prepare(
      `INSERT INTO hourly_runs (logical_hour_utc, started_at_utc, status) VALUES (?, ?, 'completed')`,
    )
    .run(iso(BASE), iso(BASE));
  fixture.sqlite
    .prepare(
      `INSERT INTO hourly_runs (logical_hour_utc, started_at_utc, status) VALUES (?, ?, 'failed')`,
    )
    .run(iso(BASE - 3_600_000), iso(BASE + 30_000));
  const latest = await fixture.db
    .prepare(LATEST_ATTEMPT_SQL)
    .first<AttemptRow>();
  assert.equal(latest?.logical_hour_utc, iso(BASE - 3_600_000));
  assert.equal(latest?.status, 'failed');
});
