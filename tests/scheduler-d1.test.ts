import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureHourlyCollection } from '../lib/collector/scheduler-watchdog.ts';
import { ensureDeepAnalysis } from '../lib/collector/deep-analysis-watchdog.ts';

// Node SQLite does not enforce all production D1 limits. In particular, the
// old seven-way UNION ALL passed those tests but failed on workerd's D1.
void test('watchdog barriers and atomic reservation work with Cloudflare D1', async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      compatibilityDate: '2026-09-02',
      d1Databases: ['DB'],
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    for (const sql of readFileSync(new URL(file, directory), 'utf8')
      .split('--> statement-breakpoint')
      .filter((statement) => statement.trim())) {
      await db.prepare(sql).run();
    }
  }
  const base = Date.parse('2026-09-07T11:00:00.000Z');
  const at = (minute: number) => base + minute * 60_000;
  const iso = (minute: number) => new Date(at(minute)).toISOString();
  let posts = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      posts++;
      return new Response(null, { status: 204 });
    }
    return Response.json({ total_count: 0, workflow_runs: [] });
  };
  const check = (minute: number) =>
    ensureHourlyCollection(
      {
        DB: db as unknown as D1Database,
        GITHUB_ACTIONS_TOKEN: 'test-only-token',
      },
      at(minute),
      fetcher,
      () => at(minute),
    );
  assert.equal((await check(0)).status, 'waiting');
  assert.equal((await check(25)).status, 'dispatched');
  assert.equal(posts, 1);
  await db
    .prepare(
      "INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status) VALUES (?1,?2,'completed')",
    )
    .bind(iso(0), iso(25))
    .run();
  await db
    .prepare(
      "INSERT INTO reddit_source_state(source,cooldown_until_utc) VALUES ('arctic-shift',?1)",
    )
    .bind(iso(90))
    .run();
  // Actual completion wins over cooldown. Next hour, cooldown blocks dispatch.
  assert.equal((await check(50)).status, 'completed');
  assert.equal((await check(85)).status, 'cooldown');
  assert.equal(posts, 1);
  await db
    .prepare(
      "UPDATE reddit_source_state SET lease_until_utc = ?1 WHERE source = 'arctic-shift'",
    )
    .bind(iso(115))
    .run();
  assert.equal((await check(110)).status, 'running');
  assert.equal((await check(116)).status, 'dispatched');
  assert.equal(posts, 2);
  const deepEnv = {
    DB: db as unknown as D1Database,
    GITHUB_ACTIONS_TOKEN: 'test-only-token',
  };
  assert.equal(
    (await ensureDeepAnalysis(deepEnv, at(116), fetcher, () => at(116))).status,
    'dispatched',
  );
  assert.equal(posts, 3);
  await db
    .prepare(
      "INSERT INTO deep_analysis_runs(day, token, status, started_at_utc) VALUES (?1, ?2, 'completed', ?3)",
    )
    .bind('2026-09-07', 'deep-test', iso(116))
    .run();
  assert.equal(
    (await ensureDeepAnalysis(deepEnv, at(150), fetcher, () => at(150))).status,
    'completed',
  );
  assert.equal(posts, 3);
});
