import assert from 'node:assert/strict';
import test from 'node:test';
import { testDb } from './d1-test-db.ts';
import { ensureDeepAnalysis } from '../lib/collector/deep-analysis-watchdog.ts';
import { runHourly } from '../lib/collector/jobs.ts';

const BASE = Date.parse('2026-09-08T00:00:00Z');
const MINUTE = 60_000;
const at = (minute: number) => BASE + minute * MINUTE;
const iso = (minute: number) => new Date(at(minute)).toISOString();
const TOKEN = 'test-only-deep-watchdog';
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const empty = () => Response.json({ total_count: 0, workflow_runs: [] });
function github(
  reply?: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: URL; method: string }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(
      url.pathname,
      '/repos/kk1030-bit/etfs-data-form-reddit/actions/workflows/deep-analysis.yml' +
        (method === 'POST' ? '/dispatches' : '/runs'),
    );
    assert.equal(
      new Headers(init.headers).get('Authorization'),
      `Bearer ${TOKEN}`,
    );
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    if (method === 'POST') {
      assert.equal(typeof init.body, 'string');
      assert.deepEqual(JSON.parse(init.body as string), { ref: 'main' });
    } else {
      assert.ok(ACTIVE.includes(url.searchParams.get('status')!));
      assert.equal(url.searchParams.get('per_page'), '1');
      assert.equal(url.searchParams.has('branch'), false);
    }
    return reply
      ? reply(url, init)
      : method === 'POST'
        ? new Response(null, { status: 204 })
        : empty();
  };
  return {
    fetcher,
    calls,
    posts: () => calls.filter((c) => c.method === 'POST').length,
  };
}

void test('deep daily watchdog waits for Beijing 08:50, then dispatches only the missing daily workflow', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = github();
  const env = { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN };
  for (const minute of [0, 25, 30, 49.999]) {
    const result = await ensureDeepAnalysis(env, at(minute), gh.fetcher, () =>
      at(minute),
    );
    assert.equal(result.status, 'waiting');
    assert.equal(result.attempts, 0);
  }
  assert.equal(gh.calls.length, 0);
  const result = await ensureDeepAnalysis(env, at(50), gh.fetcher, () =>
    at(50),
  );
  assert.equal(result.status, 'dispatched');
  assert.equal(result.attempts, 1);
  assert.equal(result.nextCheckAt, iso(60));
  assert.equal(gh.calls.length, 6);
  for (const table of [
    'deep_analysis_runs',
    'scheduler_checks',
    'hourly_runs',
    'job_runs',
    'ai_daily_usage',
  ])
    assert.equal(
      f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n,
      0,
    );
});

for (const [runStatus, expected, age] of [
  ['completed', 'completed', 60],
  ['partial', 'failed', 60],
  ['failed', 'failed', 60],
  ['collecting', 'running', 1],
  ['processing', 'running', 1],
  ['collecting', 'failed', 21],
  ['unexpected', 'failed', 1],
] as const) {
  void test(`daily ${runStatus} age ${age} blocks dispatch without resetting source/AI budgets`, async (t) => {
    const f = testDb();
    t.after(f.close);
    f.sqlite
      .prepare(
        'INSERT INTO deep_analysis_runs(day, token, status, started_at_utc, requests) VALUES (?, ?, ?, ?, ?)',
      )
      .run('2026-09-08', 'original-token', runStatus, iso(100 - age), 22);
    f.sqlite
      .prepare('INSERT INTO ai_daily_usage(day, requests) VALUES (?, ?)')
      .run('2026-09-08', 128);
    const before = f.sqlite.prepare('SELECT * FROM deep_analysis_runs').all();
    const gh = github();
    const result = await ensureDeepAnalysis(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(100),
      gh.fetcher,
      () => at(100),
    );
    assert.equal(result.status, expected);
    assert.equal(result.attempts, 0);
    assert.equal(gh.calls.length, 0);
    assert.deepEqual(
      f.sqlite.prepare('SELECT * FROM deep_analysis_runs').all(),
      before,
    );
    assert.equal(
      f.sqlite.prepare('SELECT requests FROM ai_daily_usage').get()?.requests,
      128,
    );
  });
}

for (const status of ACTIVE) {
  void test(`queued/running GitHub state ${status} suppresses a duplicate daily dispatch`, async (t) => {
    const f = testDb();
    t.after(f.close);
    const gh = github((url) =>
      url.searchParams.get('status') === status
        ? Response.json({ total_count: 1, workflow_runs: [{}] })
        : empty(),
    );
    const result = await ensureDeepAnalysis(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(50),
      gh.fetcher,
      () => at(50),
    );
    assert.equal(result.status, 'running');
    assert.equal(result.attempts, 0);
    assert.equal(gh.posts(), 0);
  });
}

void test('parallel checks and ambiguous POST failures share a daily two-attempt cap and 30-minute delay', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = github((_url, init) => {
    if (init.method === 'POST') throw new Error('must-not-leak-secret');
    return empty();
  });
  const env = { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN };
  await Promise.all(
    Array.from({ length: 8 }, () =>
      ensureDeepAnalysis(env, at(50), gh.fetcher, () => at(50)),
    ),
  );
  assert.equal(gh.posts(), 1);
  assert.equal(
    (await ensureDeepAnalysis(env, at(60), gh.fetcher, () => at(60))).attempts,
    1,
  );
  const second = await ensureDeepAnalysis(env, at(85), gh.fetcher, () =>
    at(85),
  );
  assert.equal(second.attempts, 2);
  assert.equal(second.error, 'github_dispatch_network_error');
  const capped = await ensureDeepAnalysis(env, at(120), gh.fetcher, () =>
    at(120),
  );
  assert.equal(capped.status, 'exhausted');
  assert.equal(gh.posts(), 2);
  const nextDay = await ensureDeepAnalysis(env, at(1490), gh.fetcher, () =>
    at(1490),
  );
  assert.equal(nextDay.day, '2026-09-09');
  assert.equal(nextDay.attempts, 1);
  assert.equal(gh.posts(), 3);
});

void test('normal collection claiming the day during GitHub lookup blocks the atomic reservation', async (t) => {
  const f = testDb();
  t.after(f.close);
  let claimed = false;
  const gh = github(() => {
    if (!claimed) {
      claimed = true;
      f.sqlite
        .prepare(
          'INSERT INTO deep_analysis_runs(day,token,status,started_at_utc) VALUES (?,?,?,?)',
        )
        .run('2026-09-08', 'manual', 'collecting', iso(50));
    }
    return empty();
  });
  const result = await ensureDeepAnalysis(
    { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
    at(50),
    gh.fetcher,
    () => at(50),
  );
  assert.equal(result.status, 'running');
  assert.equal(result.attempts, 0);
  assert.equal(gh.posts(), 0);
});

void test('stale/future/cross-day events never create checks or dispatch previous dates', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = github();
  const env = { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN };
  for (const scheduled of [NaN, at(44), at(51), BASE - 1])
    assert.equal(
      (await ensureDeepAnalysis(env, scheduled, gh.fetcher, () => at(50)))
        .error,
      'stale_schedule',
    );
  assert.equal(gh.calls.length, 0);
  assert.equal(
    f.sqlite
      .prepare('SELECT COUNT(*) n FROM deep_analysis_scheduler_checks')
      .get()?.n,
    0,
  );
  let clock = at(1439);
  const cross = github(() => {
    clock = at(1440);
    return empty();
  });
  assert.equal(
    (await ensureDeepAnalysis(env, at(1439), cross.fetcher, () => clock)).error,
    'stale_schedule',
  );
  assert.equal(cross.posts(), 0);
});

void test('missing credentials and invalid GitHub responses fail closed without exposing upstream body', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = github();
  assert.equal(
    (await ensureDeepAnalysis({ DB: f.db }, at(50), gh.fetcher, () => at(50)))
      .status,
    'unconfigured',
  );
  assert.equal(gh.calls.length, 0);
  for (const status of [401, 403, 429, 302, 500, 200]) {
    const invalid = github(
      () => new Response('must-not-leak-secret', { status }),
    );
    const result = await ensureDeepAnalysis(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(50),
      invalid.fetcher,
      () => at(50),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts, 0);
    assert.equal(invalid.posts(), 0);
    assert.ok(!JSON.stringify(result).includes('must-not-leak-secret'));
  }
});

void test('retention expires only deep watchdog checks; actual historical runs remain untouched', async (t) => {
  const f = testDb();
  t.after(f.close);
  for (const day of ['2026-08-30', '2026-09-07']) {
    f.sqlite
      .prepare(
        'INSERT INTO deep_analysis_scheduler_checks(day,checked_at_utc,status) VALUES (?,?,?)',
      )
      .run(day, iso(0), 'completed');
    f.sqlite
      .prepare(
        'INSERT INTO deep_analysis_runs(day,token,status,started_at_utc) VALUES (?,?,?,?)',
      )
      .run(day, 'history', 'completed', iso(0));
  }
  await ensureDeepAnalysis({ DB: f.db }, at(25), github().fetcher, () =>
    at(25),
  );
  assert.equal(
    f.sqlite
      .prepare('SELECT COUNT(*) n FROM deep_analysis_scheduler_checks')
      .get()?.n,
    2,
  );
  assert.equal(
    f.sqlite.prepare('SELECT COUNT(*) n FROM deep_analysis_runs').get()?.n,
    2,
  );
});

void test('existing Cloudflare hourly job checks deep independently without changing hourly collection history', async (t) => {
  const f = testDb();
  t.after(f.close);
  const oldClock = Date.now,
    oldFetch = globalThis.fetch;
  t.after(() => {
    Date.now = oldClock;
    globalThis.fetch = oldFetch;
  });
  Date.now = () => at(50);
  f.sqlite
    .prepare(
      'INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status) VALUES (?,?,?)',
    )
    .run(iso(0), iso(25), 'completed');
  const before = f.sqlite.prepare('SELECT * FROM hourly_runs').all();
  const gh = github();
  globalThis.fetch = gh.fetcher;
  const result = await runHourly(
    {
      DB: f.db,
      REDDIT_SOURCE_MODE: 'arctic-shift',
      ARCTIC_SHIFT_EXTERNAL: '1',
      GITHUB_ACTIONS_TOKEN: TOKEN,
    },
    at(50),
  );
  assert.equal(result.scheduler?.status, 'completed');
  assert.equal(result.deepScheduler?.status, 'dispatched');
  assert.equal(gh.posts(), 1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM hourly_runs').all(), before);
});

void test('deep D1 outage does not stop the separate hourly watchdog or leak database errors', async (t) => {
  const f = testDb();
  t.after(f.close);
  const oldClock = Date.now;
  Date.now = () => at(50);
  t.after(() => {
    Date.now = oldClock;
  });
  f.sqlite
    .prepare(
      'INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status) VALUES (?,?,?)',
    )
    .run(iso(0), iso(25), 'completed');
  const db = {
    batch: <T>(statements: D1PreparedStatement[]) => f.db.batch<T>(statements),
    prepare(sql: string) {
      if (sql.includes('deep_analysis_scheduler_checks'))
        throw new Error('private-db-error');
      return f.db.prepare(sql);
    },
  } as D1Database;
  const result = await runHourly(
    { DB: db, REDDIT_SOURCE_MODE: 'arctic-shift', ARCTIC_SHIFT_EXTERNAL: '1' },
    at(50),
  );
  assert.equal(result.scheduler?.status, 'completed');
  assert.equal(result.deepScheduler?.status, 'failed');
  assert.equal(result.deepScheduler?.error, 'deep_scheduler_check_failed');
});
