import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDb } from './d1-test-db.ts';
import { logicalHourIso } from '../lib/collector/core.ts';
import { runHourly } from '../lib/collector/jobs.ts';
import { normalizeIndexedPost } from '../lib/collector/arctic-shift.ts';
import { parseArcticSnapshot } from '../lib/collector/arctic-snapshot.ts';
import {
  ensureHourlyCollection,
  nextSchedulerCheckAt,
  readSchedulerCheck,
} from '../lib/collector/scheduler-watchdog.ts';

const BASE = Date.parse('2026-09-07T06:00:00.000Z');
const HOUR = logicalHourIso(BASE);
const MINUTE = 60_000;
const TOKEN = 'test-only-github-token';
const WORKFLOW =
  'https://api.github.com/repos/kk1030-bit/etfs-data-form-reddit/actions/workflows/title-index.yml';
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const iso = (ms: number) => new Date(ms).toISOString();
const at = (minute: number) => BASE + minute * MINUTE;
const emptyRuns = () => Response.json({ total_count: 0, workflow_runs: [] });

function fakeGithub(
  reply?: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: URL; method: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(
      url.pathname,
      new URL(WORKFLOW).pathname +
        (method === 'POST' ? '/dispatches' : '/runs'),
    );
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get('Accept'), 'application/vnd.github+json');
    assert.equal(headers.get('X-GitHub-Api-Version'), '2026-03-10');
    assert.match(headers.get('User-Agent') ?? '', /etfs/);
    if (method === 'POST') {
      assert.equal(url.search, '');
      assert.ok(typeof init?.body === 'string');
      assert.deepEqual(JSON.parse(init.body), { ref: 'main' });
    } else {
      assert.equal(method, 'GET');
      assert.ok(ACTIVE.includes(url.searchParams.get('status')!));
      assert.equal(url.searchParams.get('per_page'), '1');
      assert.equal(url.searchParams.has('branch'), false);
    }
    return reply
      ? reply(url, init!)
      : method === 'POST'
        ? new Response(null, { status: 204 })
        : emptyRuns();
  };
  return {
    fetcher,
    calls,
    posts: () => calls.filter((call) => call.method === 'POST').length,
  };
}

void test('watchdog waits until :25 and reports actual :00/:25/:50 checks', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = fakeGithub();
  assert.equal(await readSchedulerCheck(f.db), null);
  for (const minute of [0, 10, 24.999]) {
    const r = await ensureHourlyCollection(
      { DB: f.db },
      at(minute),
      gh.fetcher,
      () => at(minute),
    );
    assert.equal(r.status, 'waiting');
    assert.equal(r.nextCheckAt, iso(at(25)));
    assert.equal(r.attempts, 0);
  }
  assert.equal(gh.calls.length, 0);
  assert.equal(nextSchedulerCheckAt(at(25)), iso(at(50)));
  assert.equal(nextSchedulerCheckAt(at(50)), iso(at(60)));
  assert.equal(nextSchedulerCheckAt(at(60)), iso(at(85)));
});
void test('missing token is explicit without fabricating a collection run', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = fakeGithub();
  for (const token of [undefined, '', '  ']) {
    const r = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: token },
      at(25),
      gh.fetcher,
      () => at(25),
    );
    assert.equal(r.status, 'unconfigured');
    assert.equal(r.error, 'github_actions_token_missing');
    assert.equal(r.attempts, 0);
    assert.deepEqual(await readSchedulerCheck(f.db), r);
  }
  assert.equal(gh.calls.length, 0);
  for (const table of ['job_runs', 'hourly_runs', 'reddit_source_state'])
    assert.equal(
      f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      0,
    );
});
void test('old-hour, delayed, invalid, future events cannot backfill or overwrite checks', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = fakeGithub();
  for (const scheduled of [BASE - 1, at(19), at(26), NaN]) {
    const r = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      scheduled,
      gh.fetcher,
      () => at(25),
    );
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'stale_schedule');
  }
  assert.equal(gh.calls.length, 0);
  assert.equal(await readSchedulerCheck(f.db), null);
});
for (const table of ['job_runs', 'hourly_runs']) {
  void test(`completed current hour in ${table} suppresses dispatch`, async (t) => {
    const f = testDb();
    t.after(f.close);
    if (table === 'job_runs')
      f.sqlite
        .prepare(
          "INSERT INTO job_runs(id,job_type,logical_time_utc,started_at_utc,status) VALUES ('job','hourly',?,?,'completed')",
        )
        .run(HOUR, iso(at(10)));
    else
      f.sqlite
        .prepare(
          "INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status) VALUES (?,?,'completed')",
        )
        .run(HOUR, iso(at(10)));
    const gh = fakeGithub();
    const r = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(25),
      gh.fetcher,
      () => at(25),
    );
    assert.equal(r.status, 'completed');
    assert.equal(r.attempts, 0);
    assert.equal(gh.calls.length, 0);
  });
}
for (const barrier of [
  'source_cooldown',
  'source_lease',
  'hourly_cooldown',
  'hourly_deferred',
  'job_running',
  'hourly_running',
  'watchdog_lease',
]) {
  void test(`${barrier} prevents dispatch without clearing source state`, async (t) => {
    const f = testDb();
    t.after(f.close);
    if (barrier.startsWith('source_'))
      f.sqlite
        .prepare(
          "INSERT INTO reddit_source_state(source,cooldown_until_utc,lease_token,lease_until_utc,execution_context,cooldown_origin) VALUES ('arctic-shift',?,'original-lease',?,'github:original-context','header')",
        )
        .run(
          barrier === 'source_cooldown' ? iso(at(80)) : null,
          barrier === 'source_lease' ? iso(at(30)) : null,
        );
    if (barrier === 'hourly_cooldown' || barrier === 'hourly_deferred')
      f.sqlite
        .prepare(
          "INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status,retry_at_utc,source_mode) VALUES (?,?,?,?,'arctic-shift')",
        )
        .run(
          HOUR,
          iso(at(10)),
          barrier === 'hourly_cooldown' ? 'cooldown' : 'deferred',
          iso(at(35)),
        );
    if (barrier === 'job_running')
      f.sqlite
        .prepare(
          "INSERT INTO job_runs(id,job_type,logical_time_utc,started_at_utc,status) VALUES ('job','hourly',?,?,'running')",
        )
        .run(HOUR, iso(at(10)));
    if (barrier === 'hourly_running')
      f.sqlite
        .prepare(
          "INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status) VALUES (?,?,'running')",
        )
        .run(HOUR, iso(at(10)));
    if (barrier === 'watchdog_lease')
      f.sqlite
        .prepare(
          "INSERT INTO scheduler_checks(logical_hour_utc,checked_at_utc,status,lease_token,lease_until_utc) VALUES (?,?,'waiting','other-check',?)",
        )
        .run(HOUR, iso(at(25)), iso(at(27)));
    const before = f.sqlite.prepare('SELECT * FROM reddit_source_state').all();
    const gh = fakeGithub();
    const r = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(25),
      gh.fetcher,
      () => at(25),
    );
    assert.equal(
      r.status,
      barrier.includes('cooldown') || barrier === 'hourly_deferred'
        ? 'cooldown'
        : 'running',
    );
    assert.equal(r.attempts, 0);
    assert.equal(gh.calls.length, 0);
    assert.deepEqual(
      f.sqlite.prepare('SELECT * FROM reddit_source_state').all(),
      before,
    );
  });
}
void test('expired limits and stale jobs permit retry without changing collection rows', async (t) => {
  const f = testDb();
  t.after(f.close);
  f.sqlite
    .prepare(
      "INSERT INTO reddit_source_state(source,cooldown_until_utc,lease_token,lease_until_utc,execution_context) VALUES ('arctic-shift',?,'old',?,'old-context')",
    )
    .run(iso(at(20)), iso(at(20)));
  f.sqlite
    .prepare(
      "INSERT INTO job_runs(id,job_type,logical_time_utc,started_at_utc,status) VALUES ('job','hourly',?,?,'running')",
    )
    .run(HOUR, iso(at(0)));
  const before = f.sqlite.prepare('SELECT * FROM reddit_source_state').all();
  const gh = fakeGithub();
  const r = await ensureHourlyCollection(
    { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
    at(25),
    gh.fetcher,
    () => at(25),
  );
  assert.equal(r.status, 'dispatched');
  assert.equal(gh.posts(), 1);
  assert.deepEqual(
    f.sqlite.prepare('SELECT * FROM reddit_source_state').all(),
    before,
  );
  assert.equal(
    f.sqlite.prepare('SELECT status FROM job_runs').get()?.status,
    'running',
  );
});
for (const status of ACTIVE) {
  void test(`GitHub ${status} suppresses a duplicate`, async (t) => {
    const f = testDb();
    t.after(f.close);
    const gh = fakeGithub((url) =>
      url.searchParams.get('status') === status
        ? Response.json({
            total_count: 1,
            workflow_runs: [{ status, head_branch: 'another-branch' }],
          })
        : emptyRuns(),
    );
    const r = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(25),
      gh.fetcher,
      () => at(25),
    );
    assert.equal(r.status, 'running');
    assert.equal(r.attempts, 0);
    assert.equal(gh.calls.length, 5);
    assert.equal(gh.posts(), 0);
  });
}
for (const status of [200, 204]) {
  void test(`dispatch HTTP ${status} is accepted, never follows its run URL`, async (t) => {
    const f = testDb();
    t.after(f.close);
    const gh = fakeGithub((_url, init) =>
      init.method === 'POST'
        ? status === 204
          ? new Response(null, { status })
          : Response.json({ run_url: 'https://untrusted.test/never-follow' })
        : emptyRuns(),
    );
    const r = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(25),
      gh.fetcher,
      () => at(25),
    );
    assert.equal(r.status, 'dispatched');
    assert.equal(r.attempts, 1);
    assert.equal(r.lastDispatchAt, iso(at(25)));
    assert.equal(r.nextCheckAt, iso(at(50)));
    assert.equal(gh.calls.length, 6);
    for (const table of ['hourly_runs', 'job_runs'])
      assert.equal(
        f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
        0,
      );
  });
}
for (const phase of ['runs', 'dispatch']) {
  for (const status of [401, 403, 429, 302, 500]) {
    void test(`${phase} HTTP ${status} is bounded and fails closed`, async (t) => {
      const f = testDb();
      t.after(f.close);
      const gh = fakeGithub((_url, init) =>
        (init.method === 'POST') === (phase === 'dispatch')
          ? new Response(`secret ${TOKEN}`, {
              status,
              headers: {
                Location: 'https://untrusted.test/',
                'Retry-After': '60',
              },
            })
          : emptyRuns(),
      );
      const r = await ensureHourlyCollection(
        { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
        at(25),
        gh.fetcher,
        () => at(25),
      );
      assert.equal(r.status, 'failed');
      assert.equal(r.error, `github_${phase}_http_${status}`);
      assert.equal(r.attempts, phase === 'dispatch' ? 1 : 0);
      assert.equal(gh.posts(), phase === 'dispatch' ? 1 : 0);
      assert.equal(JSON.stringify(r).includes(TOKEN), false);
    });
  }
  for (const kind of ['network_error', 'timeout']) {
    void test(`${phase} ${kind} cannot expose arbitrary exception text`, async (t) => {
      const f = testDb();
      t.after(f.close);
      const gh = fakeGithub((_url, init) => {
        if ((init.method === 'POST') === (phase === 'dispatch')) {
          if (kind === 'timeout') throw new DOMException(TOKEN, 'AbortError');
          throw new Error(TOKEN);
        }
        return emptyRuns();
      });
      const r = await ensureHourlyCollection(
        { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
        at(25),
        gh.fetcher,
        () => at(25),
      );
      assert.equal(r.status, 'failed');
      assert.equal(r.error, `github_${phase}_${kind}`);
      assert.equal(r.attempts, phase === 'dispatch' ? 1 : 0);
      assert.equal(JSON.stringify(r).includes(TOKEN), false);
    });
  }
}
void test('unresponsive dispatch is aborted at deadline and consumes one attempt', async (t) => {
  const f = testDb();
  t.after(f.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered!: () => void;
  const posted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  const gh = fakeGithub((_url, init) => {
    if (init.method !== 'POST') return emptyRuns();
    signal = init.signal!;
    entered();
    return new Promise<Response>(() => {});
  });
  const pending = ensureHourlyCollection(
    { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
    at(25),
    gh.fetcher,
    () => at(25),
  );
  await posted;
  t.mock.timers.tick(8_000);
  const r = await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(r.error, 'github_dispatch_timeout');
  assert.equal(r.attempts, 1);
});
void test('malformed workflow listings cannot authorize dispatch', async (t) => {
  const f = testDb();
  t.after(f.close);
  for (const body of [
    {},
    { total_count: 0, workflow_runs: [{}] },
    { total_count: 1, workflow_runs: [] },
    { total_count: -1, workflow_runs: [] },
  ]) {
    const gh = fakeGithub(() => Response.json(body));
    const r = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(25),
      gh.fetcher,
      () => at(25),
    );
    assert.equal(r.error, 'github_runs_invalid_response');
    assert.equal(r.attempts, 0);
    assert.equal(gh.posts(), 0);
  }
});
void test('concurrency/retries/ambiguous POST share an atomic two-attempt budget', async (t) => {
  const f = testDb();
  t.after(f.close);
  let now = at(25);
  const gh = fakeGithub((_url, init) => {
    if (init.method === 'POST') throw new Error('ambiguous dispatch');
    return emptyRuns();
  });
  const check = () =>
    ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      now,
      gh.fetcher,
      () => now,
    );
  await Promise.all(Array.from({ length: 12 }, check));
  assert.equal(gh.posts(), 1);
  assert.equal((await readSchedulerCheck(f.db))?.attempts, 1);
  await check();
  now = at(44.999);
  await check();
  assert.equal(gh.posts(), 1);
  now = at(50);
  await Promise.all(Array.from({ length: 12 }, check));
  assert.equal(gh.posts(), 2);
  now = at(59);
  assert.equal((await check()).status, 'failed');
  assert.equal(
    (await readSchedulerCheck(f.db))?.error,
    'github_dispatch_network_error',
  );
  assert.equal(gh.posts(), 2);
  assert.equal((await readSchedulerCheck(f.db))?.attempts, 2);
  now = at(85);
  assert.equal((await check()).attempts, 1);
  assert.equal(gh.posts(), 3);
});
void test('second accepted dispatch stays pending during its execution window', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = fakeGithub();
  for (const minute of [25, 50, 50.01, 59]) {
    const result = await ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(minute),
      gh.fetcher,
      () => at(minute),
    );
    assert.equal(result.status, 'dispatched');
    assert.equal(result.error, null);
    assert.equal(result.attempts, minute === 25 ? 1 : 2);
  }
  assert.equal(gh.posts(), 2);
  assert.equal(gh.calls.length, 12);
});
void test('spent budget reports an active GitHub run before declaring exhaustion', async (t) => {
  const f = testDb();
  t.after(f.close);
  f.sqlite
    .prepare(
      "INSERT INTO scheduler_checks(logical_hour_utc,checked_at_utc,status,attempts,last_dispatch_at_utc) VALUES (?,?,'dispatched',2,?)",
    )
    .run(HOUR, iso(at(25)), iso(at(25)));
  let active = true;
  const gh = fakeGithub((url) =>
    active && url.searchParams.get('status') === 'queued'
      ? Response.json({ total_count: 1, workflow_runs: [{ status: 'queued' }] })
      : emptyRuns(),
  );
  const check = () =>
    ensureHourlyCollection(
      { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
      at(50),
      gh.fetcher,
      () => at(50),
    );
  assert.equal((await check()).status, 'running');
  active = false;
  assert.equal((await check()).status, 'exhausted');
  assert.equal(gh.posts(), 0);
  assert.equal((await readSchedulerCheck(f.db))?.attempts, 2);
});
void test('collection completed during lookup blocks the atomic dispatch reservation', async (t) => {
  const f = testDb();
  t.after(f.close);
  const gh = fakeGithub(() => {
    f.sqlite
      .prepare(
        "INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status) VALUES (?,?,'completed') ON CONFLICT DO NOTHING",
      )
      .run(HOUR, iso(at(10)));
    return emptyRuns();
  });
  const r = await ensureHourlyCollection(
    { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
    at(25),
    gh.fetcher,
    () => at(25),
  );
  assert.equal(r.status, 'completed');
  assert.equal(r.attempts, 0);
  assert.equal(gh.posts(), 0);
});
void test('clock crossing hour during lookup cannot dispatch an old hour', async (t) => {
  const f = testDb();
  t.after(f.close);
  const scheduled = at(59.999);
  let now = scheduled;
  const gh = fakeGithub(() => {
    now = at(60);
    return emptyRuns();
  });
  const r = await ensureHourlyCollection(
    { DB: f.db, GITHUB_ACTIONS_TOKEN: TOKEN },
    scheduled,
    gh.fetcher,
    () => now,
  );
  assert.equal(r.error, 'stale_schedule');
  assert.equal(r.attempts, 0);
  assert.equal(gh.posts(), 0);
});
void test('retention removes only watchdog checks older than seven days', async (t) => {
  const f = testDb();
  t.after(f.close);
  const old = iso(BASE - 8 * 24 * 3_600_000);
  f.sqlite
    .prepare(
      "INSERT INTO scheduler_checks(logical_hour_utc,checked_at_utc,status) VALUES (?,?,'failed')",
    )
    .run(old, old);
  f.sqlite
    .prepare(
      "INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status) VALUES (?,?,'completed')",
    )
    .run(old, old);
  await ensureHourlyCollection({ DB: f.db }, at(25), fakeGithub().fetcher, () =>
    at(25),
  );
  assert.equal(
    f.sqlite
      .prepare(
        'SELECT COUNT(*) AS n FROM scheduler_checks WHERE logical_hour_utc = ?',
      )
      .get(old)?.n,
    0,
  );
  assert.equal(
    f.sqlite
      .prepare(
        'SELECT COUNT(*) AS n FROM hourly_runs WHERE logical_hour_utc = ?',
      )
      .get(old)?.n,
    1,
  );
});
void test('real external snapshot completes the logical hour watched by the scheduler', async (t) => {
  const f = testDb();
  t.after(f.close);
  const realNow = Date.now();
  const checkedAt = Date.parse(logicalHourIso(realNow)) + 50 * MINUTE;
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new Error('Unexpected source fetch');
  };
  const env = {
    DB: f.db,
    REDDIT_SOURCE_MODE: 'arctic_shift',
    REDDIT_SUBREDDITS: 'ETFs',
    ARCTIC_SHIFT_EXTERNAL: '1',
    TITLE_INDEX_EXTERNAL: '1',
  };
  const candidate = normalizeIndexedPost({
    id: 'watchdog1',
    subreddit: 'ETFs',
    author: 'fixture-author',
    title: 'VOO or VTI for my ETF portfolio?',
    selftext: 'Comparing long-term ETF investments.',
    permalink: '/r/ETFs/comments/watchdog1/portfolio/',
    created_utc: Math.floor(realNow / 1000) - 1800,
    retrieved_on: Math.floor(realNow / 1000) - 1700,
  });
  assert.ok(candidate);
  const snapshot = parseArcticSnapshot(
    {
      candidates: [candidate],
      trackedRaw: [],
      commentCounts: [['t3_watchdog1', 2]],
      details: { communities: ['ETFs'], warnings: [] },
    },
    env,
    realNow,
  );
  const collected = await runHourly(env, realNow, { snapshot });
  assert.equal(collected.status, 'completed');
  assert.equal(collected.selected, 1);
  assert.equal(collected.logicalTimeUtc, logicalHourIso(realNow));
  const gh = fakeGithub();
  const checked = await ensureHourlyCollection(
    env,
    checkedAt,
    gh.fetcher,
    () => checkedAt,
  );
  assert.equal(checked.logicalHour, collected.logicalTimeUtc);
  assert.equal(checked.status, 'completed');
  assert.equal(checked.attempts, 0);
  assert.equal(gh.calls.length, 0);
});
