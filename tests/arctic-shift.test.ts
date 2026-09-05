import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchIndexedCandidates,
  normalizeIndexedPost,
  refreshIndexedPosts,
} from '../lib/collector/arctic-shift.ts';
import { scoreCandidates, logicalHourIso } from '../lib/collector/core.ts';
import { runHourly, runDaily, runWeekly } from '../lib/collector/jobs.ts';
import {
  analyzePost,
  preserveCurrencyUncertainty,
} from '../lib/collector/llm.ts';
import {
  readRssSourceState,
  withRssCooldown,
  RssDeferredError,
} from '../lib/collector/rss-cooldown.ts';
import { RedditRssError } from '../lib/collector/reddit-rss.ts';
import { testDb } from './d1-test-db.ts';

const now = Date.now();
const post = (id = 'abc123', extra: Record<string, unknown> = {}) => ({
  id,
  subreddit: 'ETFs',
  author: `author_${id}`,
  title: 'VOO or VTI for my ETF portfolio?',
  selftext:
    'I want to compare VOO and VTI for a long-term ETF portfolio. What should I consider?',
  permalink: `/r/ETFs/comments/${id}/portfolio/`,
  created_utc: Math.floor(now / 1000) - 1800,
  retrieved_on: Math.floor(now / 1000) - 1700,
  score: 999,
  num_comments: 888,
  ...extra,
});
const response = (data: unknown[]) => Response.json({ data });

void test('translation never invents a currency absent from the source', () => {
  assert.equal(
    preserveCurrencyUncertainty(
      '从 500 美元开始',
      'Starting with 500 on Pearler',
    ),
    '从 500 开始',
  );
  assert.equal(
    preserveCurrencyUncertainty('从 500 美元开始', 'Starting with 500 USD'),
    '从 500 美元开始',
  );
  assert.equal(
    preserveCurrencyUncertainty('500 澳元或加元', '500 AUD'),
    '500 澳元或',
  );
});

void test('daily and weekly archive factual reports when the free AI service fails', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const deadline = Date.parse('2026-09-07T16:00:00.000Z');
  const previousDay = '2026-09-06T17:00:00.000Z';
  const title = 'ETF allocation';
  fixture.sqlite
    .prepare(
      "INSERT INTO reddit_posts (id,reddit_id,subreddit,author,permalink,title_original,body_original,content_hash,source_platform,created_at_utc,first_seen_at_utc,last_seen_at_utc,topics_json) VALUES ('t3_old1','old1','ETFs','author','https://www.reddit.com/r/ETFs/comments/old1/',?,'','hash','reddit',?,?,?,'[\"ETF 配置\"]')",
    )
    .run(title, previousDay, previousDay, previousDay);
  fixture.sqlite
    .prepare(
      "INSERT INTO hourly_runs (logical_hour_utc,started_at_utc,status,source_mode) VALUES (?,?,'completed','arctic-shift')",
    )
    .run(previousDay, previousDay);
  fixture.sqlite
    .prepare(
      "INSERT INTO hourly_rankings (logical_hour_utc,rank,post_id,heat_score,components_json) VALUES (?,1,'t3_old1',75,'{}')",
    )
    .run(previousDay);
  const env = {
    DB: fixture.db,
    REDDIT_SOURCE_MODE: 'arctic_shift',
    AI: {
      run: async () => {
        throw new Error('quota exhausted');
      },
    },
  };
  assert.equal((await runDaily(env, deadline)).status, 'completed');
  const daily = fixture.sqlite
    .prepare('SELECT sections_json FROM daily_reports')
    .get();
  assert.equal(
    JSON.parse(String(daily?.sections_json)).analysisStatus,
    'aggregate',
  );
  // Populate all seven preceding dates with long themes: only a compact copy is sent to AI.
  for (let day = 0; day < 7; day++) {
    const date = new Date(Date.parse('2026-08-31T00:00:00Z') + day * 86400000)
      .toISOString()
      .slice(0, 10);
    fixture.sqlite
      .prepare(
        "INSERT INTO daily_reports (report_date,period_start_utc,period_end_utc,generated_at_utc,headline,executive_summary,sections_json,coverage_success,coverage_expected,version) VALUES (?,?,?,?,'日报','摘要',?,24,24,1) ON CONFLICT(report_date) DO NOTHING",
      )
      .run(
        date,
        previousDay,
        previousDay,
        previousDay,
        JSON.stringify({
          themes: Array.from(
            { length: 8 },
            (_, i) => '长期资产配置与指数基金的观察讨论'.repeat(3) + i,
          ),
        }),
      );
  }
  assert.equal(
    (await runWeekly(env, Date.parse('2026-09-06T16:10:00Z'))).status,
    'completed',
  );
  const weekly = fixture.sqlite
    .prepare('SELECT sections_json FROM weekly_reports')
    .get();
  assert.equal(
    JSON.parse(String(weekly?.sections_json)).analysisStatus,
    'aggregate',
  );
});

void test('archive adapter keeps canonical Reddit links, rejects removed data, and does not invent live metrics', () => {
  const normalized = normalizeIndexedPost(post());
  assert.ok(normalized);
  assert.equal(
    normalized.permalink,
    'https://www.reddit.com/r/ETFs/comments/abc123/',
  );
  assert.equal(normalized.metricsAvailable, false);
  assert.equal(normalized.score, 0);
  assert.equal(normalized.comments, 0);
  assert.equal(normalized.bestListingRank, null);
  for (const extra of [
    { is_robot_indexable: false },
    { _meta: { was_deleted_later: true } },
    { _meta: { removal_type: 'deleted' } },
    { selftext: '[removed]' },
    { over_18: true },
  ])
    assert.equal(normalizeIndexedPost(post('abc123', extra)), null);
  const scored = scoreCandidates(
    [
      { ...normalized, discussionCount: 0 },
      { ...normalized, id: 't3_other', discussionCount: 6 },
    ],
    now,
  );
  assert.equal(scored[0].id, 't3_other');
});

void test('archive discovery counts deduplicated comment samples including still-tracked older posts', async () => {
  const result = await fetchIndexedCandidates(
    { REDDIT_SUBREDDITS: 'ETFs' },
    async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, 'https://arctic-shift.photon-reddit.com');
      if (url.pathname === '/api/posts/search')
        return response([
          post(),
          post('old123', { created_utc: Math.floor(now / 1000) - 90000 }),
          post('wrong1', { subreddit: 'different' }),
        ]);
      const comment = {
        id: 'c1',
        subreddit: 'ETFs',
        created_utc: Math.floor(now / 1000) - 200,
        link_id: 't3_abc123',
      };
      return response([
        comment,
        comment,
        { ...comment, id: 'c2', link_id: 't3_old123' },
      ]);
    },
    now,
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].discussionCount, 1);
  assert.equal(result.commentCounts.get('t3_old123'), 1);
  assert.equal(result.details.commentSampleSize, 2);
});

void test('tracking refresh ignores unsolicited post IDs', async () => {
  const rows = await refreshIndexedPosts(['t3_abc123'], async () =>
    response([post(), post('intruder')]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data?.id, 'abc123');
});

void test('RSS and archive cooldowns are isolated and an archive refresh 429 remains persistent', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  await assert.rejects(
    withRssCooldown(
      fixture.db,
      async () => {
        throw new RedditRssError('Reddit RSS rate limited', 429);
      },
      () => now,
    ),
    RssDeferredError,
  );
  assert.equal(
    await withRssCooldown(
      fixture.db,
      async () => 'archive works',
      () => now,
      'arctic-shift',
    ),
    'archive works',
  );
  await assert.rejects(
    withRssCooldown(
      fixture.db,
      async () => {
        throw new RedditRssError('Arctic Shift rate limited', 429, '7200');
      },
      () => now,
      'arctic-shift',
    ),
    RssDeferredError,
  );
  assert.equal(
    (await readRssSourceState(fixture.db, 'arctic-shift'))?.cooldown_until_utc,
    new Date(now + 7200000).toISOString(),
  );
});

void test('switching source retries current RSS cooldown hour and persists real archive ranking', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const hour = logicalHourIso(now);
  const started = new Date(now - 60000).toISOString();
  fixture.sqlite
    .prepare(
      "INSERT INTO job_runs(id,job_type,logical_time_utc,started_at_utc,status) VALUES(?,'hourly',?,?,'cooldown')",
    )
    .run(`hourly:${hour}`, hour, started);
  fixture.sqlite
    .prepare(
      "INSERT INTO hourly_runs(logical_hour_utc,started_at_utc,status,source_mode,retry_at_utc) VALUES(?,?,'cooldown','rss-preview',?)",
    )
    .run(hour, started, new Date(now + 86400000).toISOString());
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input) =>
    new URL(input instanceof Request ? input.url : input).pathname ===
    '/api/posts/search'
      ? response([post()])
      : response([]);
  const result = await runHourly(
    {
      DB: fixture.db,
      REDDIT_SOURCE_MODE: 'arctic_shift',
      REDDIT_SUBREDDITS: 'ETFs',
    },
    now,
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.selected, 1);
  assert.equal(
    fixture.sqlite.prepare('SELECT source_provider FROM reddit_posts').get()
      ?.source_provider,
    'arctic-shift',
  );
  assert.equal(
    fixture.sqlite
      .prepare('SELECT metrics_available FROM post_observations')
      .get()?.metrics_available,
    0,
  );
});

void test('AI relay accepts Qwen chat responses, preserves extraction-only instructions, and stops at daily request cap', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.equal(typeof init?.body, 'string');
    const body = JSON.parse(init!.body as string);
    assert.match(body.messages[0].content, /绝对不要替作者回答/);
    return Response.json({
      choices: [
        {
          message: {
            content:
              '<think></think>{"title_zh":"VOO 与 VTI 怎么选？","translation_zh":"作者希望比较两种基金。","summary_zh":"作者询问 ETF 的选择。","highlights":["问题涉及 VOO 与 VTI","未提供比较结论"],"topics":["ETF 配置"]}',
          },
        },
      ],
    });
  };
  const env = {
    DB: fixture.db,
    WORKERS_AI_RELAY_URL:
      'https://etfs-hot-topics-collector.etfs-hot-topics-kk1030.workers.dev/ai',
    WORKERS_AI_RELAY_TOKEN: 'test-only',
  };
  assert.equal(
    (await analyzePost(env, normalizeIndexedPost(post())!))?.titleZh,
    'VOO 与 VTI 怎么选？',
  );
  fixture.sqlite.prepare('UPDATE ai_daily_usage SET requests = 128').run();
  await assert.rejects(
    analyzePost(env, normalizeIndexedPost(post())!),
    /Daily free AI budget/,
  );
  assert.equal(calls, 1);
});
