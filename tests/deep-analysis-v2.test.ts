import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreDeepAnalysis } from '../lib/collector/deep-analysis.ts';
import {
  analyzeDeepPost,
  deepAiApproved,
  deepAiTotal,
} from '../lib/collector/deep-analysis-ai.ts';
import {
  rankDeepCandidates,
  deepFinalScore,
  collectDeepDaily,
} from '../lib/collector/deep-analysis-daily.ts';
import {
  beginDeepRun,
  ingestDeepRun,
  readDeepData,
  calibrateDeepPost,
  validateDeepSnapshot,
} from '../lib/collector/deep-analysis-store.ts';
import { compareCalibration } from '../lib/collector/deep-analysis-calibration.ts';
import { DEEP_RUBRIC_VERSION } from '../lib/collector/deep-analysis-policy.ts';
import {
  DEEP_COMMUNITIES,
  type DeepPost,
} from '../lib/collector/deep-analysis-source.ts';
import { testDb } from './d1-test-db.ts';

const now = Date.now();
const iso = (ms = now) => new Date(ms).toISOString();
const post = (id = 'test', overrides: Partial<DeepPost> = {}): DeepPost => ({
  id,
  title: 'Is 60/40 dead? A look at 100 years of data',
  subreddit: 'Bogleheads',
  author: 'writer',
  selftext:
    '# VOO VTI BND\n\n**Evidence**\n- Returns\n| ETF | Return |\n| --- | --- |\n| VOO | 10% |\nhttps://testfol.io/model\n'.padEnd(
      3500,
      'x',
    ),
  created_utc: (now - 3600000) / 1000,
  retrieved_on: now / 1000,
  is_self: true,
  over_18: false,
  link_flair_text: 'Portfolio Review',
  author_flair_text: null,
  url: '',
  domain: 'self.Bogleheads',
  ...overrides,
});
const result = (
  scores = { reasoning_depth: 3, data_support: 3, reading_value: 3 },
) => ({
  title_zh: '配置分析',
  type: 'allocation' as const,
  thesis: '作者比较了资产配置的收益与风险。',
  key_data: ['原文列示收益为 10%。'],
  author_background_claimed: null,
  counterpoints: '回测未必代表未来。',
  scores,
});
const finalist = (
  id: string,
  commenters: number | null = 0,
  overrides: Partial<DeepPost> = {},
) => ({
  post: post(id, overrides),
  uniqueCommenters: commenters,
  authorLongPosts: null,
});

void test('UCITS and expanded allocation/backtest terms open the topic gate without stock tickers', () => {
  const funds = scoreDeepAnalysis(
    post('ucits', { selftext: 'VWCE IWDA EIMI SXR8 '.padEnd(1000, 'x') }),
  );
  assert.equal(funds.eligible, true);
  assert.equal(funds.details.tickers.length, 4);
  const macros = scoreDeepAnalysis(
    post('macro', {
      selftext:
        'backtest CAGR Sharpe drawdown sequence of returns SWR Monte Carlo CAPE equity risk premium correlation tax drag three-fund target date covered call buffer '.padEnd(
          1000,
          'x',
        ),
    }),
  );
  assert.equal(macros.eligible, true);
  assert.equal(macros.details.macroTerms.length, 15);
});
void test('evidence includes data sites and chart links, deduplicates domains and rejects spoofed hosts', () => {
  const s = scoreDeepAnalysis(
    post('sources', {
      selftext:
        'VOO https://www.portfoliovisualizer.com/a https://testfol.io/a https://www.morningstar.com/a https://etf.com/a https://bogleheads.org/wiki/Tax https://i.redd.it/a.png https://preview.redd.it/a.png https://i.imgur.com/a.png https://i.imgur.com/b.png https://bogleheads.org/forum https://testfol.io.evil.test/a https://fred.stlouisfed.org/series/X '.padEnd(
          2000,
          'x',
        ),
    }),
  );
  assert.equal(s.details.primarySources.length, 9);
  assert.equal(s.points.primarySources, 15);
});
void test('question penalties apply only below 2000 and only the requested title terms deduct points', () => {
  assert.equal(
    scoreDeepAnalysis(post('long', { title: 'Is VOO useful?' })).points
      .questionPenalty,
    0,
  );
  assert.equal(
    scoreDeepAnalysis(
      post('short', {
        title: 'Is VOO useful?',
        selftext: 'VOO '.padEnd(1999, 'x'),
      }),
    ).points.questionPenalty,
    -5,
  );
  assert.equal(
    scoreDeepAnalysis(
      post('short', {
        title: 'Help and advice for a beginner: should I buy?',
        selftext: 'VOO '.padEnd(1999, 'x'),
      }),
    ).points.helpPenalty,
    -10,
  );
  assert.equal(
    scoreDeepAnalysis(
      post('rate', { title: 'Rate my research: new to this topic' }),
    ).points.helpPenalty,
    0,
  );
  assert.equal(
    scoreDeepAnalysis(post('short', { selftext: 'VOO '.padEnd(999, 'x') }))
      .eligible,
    false,
  );
});
void test('review queue ranks score before date and interaction can change the winner; author history cannot', () => {
  const strongOld = finalist('strong', 0, {
    created_utc: (now - 2 * 86400000) / 1000,
  });
  const weakNew = finalist('weak', 0, {
    selftext: '# VOO VTI BND\n'.padEnd(1000, 'x'),
  });
  assert.equal(rankDeepCandidates([weakNew, strongOld])[0].post.id, 'strong');
  assert.equal(
    rankDeepCandidates([
      strongOld,
      { ...strongOld, post: post('hot'), uniqueCommenters: 31 },
    ])[0].post.id,
    'hot',
  );
  assert.equal(
    deepFinalScore(strongOld),
    deepFinalScore({ ...strongOld, authorLongPosts: 50 }),
  );
});
void test('a sparse pool sends only the available eligible articles, never inventing five reviews', async () => {
  const snapshot = await collectDeepDaily(
    { seenIds: [], authors: [] },
    async (input) => {
      const u = new URL(input instanceof Request ? input.url : input);
      return Response.json({
        data:
          u.searchParams.get('subreddit') === 'Bogleheads' &&
          !u.searchParams.has('author')
            ? [post()]
            : [],
      });
    },
    now,
    async () => {},
  );
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.finalists.length, 1);
});
void test('thinking/preamble/fenced JSON is parsed, 2000 tokens and local feature details are supplied', async () => {
  const traces: Record<string, unknown>[] = [];
  const review = await analyzeDeepPost(
    {
      AI_TRACE: (e) => traces.push(e),
      AI: {
        run: async (_model, input) => {
          assert.equal(input.max_tokens, 2000);
          assert.match(JSON.stringify(input), /no_think/);
          assert.match(JSON.stringify(input), /local_score_reference/);
          return {
            response:
              '<think>Example {invalid}</think>Here is the result:\n```json\n' +
              JSON.stringify(result()) +
              '\n```',
          };
        },
      },
    },
    post(),
  );
  assert.equal(deepAiApproved(review), true);
  assert.equal(deepAiTotal(review), 9);
  assert.equal(traces.filter((e) => e.event === 'raw_response').length, 1);
});
void test('Qwen raw text_completion and structured response objects are accepted on the first attempt', async () => {
  for (const payload of [
    {
      choices: [{ text: JSON.stringify(result()), finish_reason: 'stop' }],
      response: result(),
    },
    { response: result() },
    { result: { response: result() } },
  ]) {
    let calls = 0;
    const review = await analyzeDeepPost(
      {
        AI: {
          run: async () => {
            calls++;
            return payload;
          },
        },
      },
      post(),
    );
    assert.equal(calls, 1);
    assert.equal(deepAiTotal(review), 9);
  }
});

void test('parse failure retries once; low rubric scores are rejected without retries', async () => {
  let calls = 0;
  const traces: Record<string, unknown>[] = [];
  const review = await analyzeDeepPost(
    {
      AI_TRACE: (e) => traces.push(e),
      AI: {
        run: async () => {
          return {
            response:
              ++calls === 1
                ? '{"scores":'
                : JSON.stringify(
                    result({
                      reasoning_depth: 2,
                      data_support: 3,
                      reading_value: 3,
                    }),
                  ),
          };
        },
      },
    },
    post(),
  );
  assert.equal(calls, 2);
  assert.equal(deepAiApproved(review), false);
  assert.equal(
    traces.find((e) => e.event === 'error')?.kind,
    'parse_or_schema',
  );
  assert.equal(traces.filter((e) => e.event === 'review').length, 1);
});
void test('truncation is technical failure after two attempts, while HTTP 429 never retries', async () => {
  let calls = 0;
  await assert.rejects(
    analyzeDeepPost(
      {
        AI: {
          run: async () => {
            calls++;
            return {
              choices: [
                {
                  finish_reason: 'length',
                  message: { content: JSON.stringify(result()) },
                },
              ],
            };
          },
        },
      },
      post(),
    ),
    /truncated/,
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    analyzeDeepPost(
      {
        AI: {
          run: async () => {
            calls++;
            throw new Error('Free AI service HTTP 429');
          },
        },
      },
      post(),
    ),
    /429/,
  );
  assert.equal(calls, 1);
});
void test('candidate metadata survives failures without bodies; approved items are excluded and technical failures can retry next day', async () => {
  const t = testDb();
  try {
    const run = await beginDeepRun(t.db, now);
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => finalist(id));
    const snapshot = {
      collectedAt: iso(),
      requests: 13,
      communities: DEEP_COMMUNITIES.map((subreddit) => ({
        subreddit,
        returned: subreddit === 'Bogleheads' ? 6 : 0,
      })),
      seenIds: ['a', 'b', 'c', 'd', 'e'],
      authors: [],
      candidates,
      finalists: candidates.slice(0, 5),
    };
    const res = await ingestDeepRun(
      { DB: t.db },
      run.day,
      run.token!,
      snapshot,
      now,
      async (_env, p) => {
        if (p.id === 'b') throw new Error('technical');
        return p.id === 'a'
          ? result()
          : result({ reasoning_depth: 1, data_support: 2, reading_value: 2 });
      },
    );
    assert.deepEqual([res.accepted, res.rejected, res.failed], [1, 3, 1]);
    const data = await readDeepData(t.db, now);
    assert.equal(data.candidates?.length, 5);
    assert.equal(
      data.candidates?.some((c) => c.id === 'a'),
      false,
    );
    const stored = JSON.stringify(
      t.sqlite.prepare('SELECT * FROM deep_analysis_candidates').all(),
    );
    assert.doesNotMatch(
      stored,
      /selftext|https:\/\/testfol|counterpoints|raw_response/,
    );
    const next = await beginDeepRun(t.db, now + 86400000);
    assert.ok(!next.seenIds?.includes('b'));
    assert.ok(!next.seenIds?.includes('f'));
    assert.ok(next.seenIds?.includes('c'));
    assert.throws(
      () =>
        validateDeepSnapshot(
          { ...snapshot, finalists: [candidates[5]] },
          now,
          now,
        ),
      /top five/,
    );
  } finally {
    t.close();
  }
});
void test('old scoring-version rejections do not suppress newly eligible posts; already published cards remain deduplicated', async () => {
  const t = testDb();
  try {
    t.sqlite
      .prepare('INSERT INTO deep_analysis_seen (id, seen_at_utc) VALUES (?, ?)')
      .run('oldscore', iso());
    t.sqlite
      .prepare('INSERT INTO deep_analysis_articles VALUES (?, ?, ?, ?, ?)')
      .run('published', iso(now - 3600000), iso(), 50, '{}');
    const run = await beginDeepRun(t.db, now);
    assert.ok(!run.seenIds?.includes('oldscore'));
    assert.ok(run.seenIds?.includes('published'));
  } finally {
    t.close();
  }
});
void test('calibration uses shared quota, counts retries in its own daily budget, never publishes, and records raw invalid HTTP JSON', async () => {
  const t = testDb(),
    originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return calls === 1
        ? new Response('<html>broken gateway</html>')
        : Response.json({ response: JSON.stringify(result()) });
    };
    const env = {
      DB: t.db,
      WORKERS_AI_RELAY_URL:
        'https://etfs-hot-topics-collector.etfs-hot-topics-kk1030.workers.dev/ai',
      WORKERS_AI_RELAY_TOKEN: 'test-not-a-secret',
    };
    const reviewed = await calibrateDeepPost(env, post(), now);
    assert.equal(reviewed.status, 'accepted');
    assert.equal(reviewed.aiCalls, 2);
    assert.match(String(reviewed.diagnostics[0].raw), /broken gateway/);
    assert.equal(
      t.sqlite.prepare('SELECT requests FROM ai_daily_usage').get()?.requests,
      2,
    );
    assert.equal(
      t.sqlite.prepare('SELECT requests FROM deep_calibration_usage').get()
        ?.requests,
      2,
    );
    for (const table of [
      'deep_analysis_articles',
      'deep_analysis_candidates',
      'deep_analysis_runs',
    ])
      assert.equal(
        t.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
        0,
      );
    t.sqlite.prepare('UPDATE deep_calibration_usage SET requests = 40').run();
    assert.equal(
      (await calibrateDeepPost(env, post('other'), now)).status,
      'budget',
    );
    assert.equal(calls, 2);
    t.sqlite.prepare('UPDATE deep_calibration_usage SET requests = 0').run();
    t.sqlite.prepare('UPDATE ai_daily_usage SET requests = 128').run();
    assert.equal(
      (await calibrateDeepPost(env, post('global'), now)).status,
      'budget',
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    t.close();
  }
});
void test('calibration compares accepted and rejected features without treating technical failures as rejected', () => {
  const rows = [
    {
      id: 'a',
      rubricVersion: DEEP_RUBRIC_VERSION,
      status: 'accepted',
      features: { length: 25, data: 15 },
      aiCalls: 1,
    },
    {
      id: 'b',
      rubricVersion: DEEP_RUBRIC_VERSION,
      status: 'rejected',
      features: { length: 25, data: 5 },
      aiCalls: 1,
    },
    {
      id: 'c',
      rubricVersion: DEEP_RUBRIC_VERSION,
      status: 'failed',
      features: { length: 10, data: 0 },
      aiCalls: 2,
    },
  ];
  const report = compareCalibration(rows);
  assert.equal(report.features[0].feature, 'data');
  assert.equal(report.features[0].difference, 10);
  assert.deepEqual(
    [report.accepted, report.rejected, report.technicalFailures],
    [1, 1, 1],
  );
  assert.equal(compareCalibration([rows[0]]).features[0].difference, null);
});
