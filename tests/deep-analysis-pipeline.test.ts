import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  deepPublishedMs,
  deepIsNew,
  compareDeepRecent,
  DEEP_WINDOW_MS,
} from '../lib/collector/deep-analysis-dates.ts';
import {
  collectDeepDaily,
  deepSupplementPoints,
  rankDeepCandidates,
  type DeepDailySnapshot,
} from '../lib/collector/deep-analysis-daily.ts';
import {
  DEEP_COMMUNITIES,
  type DeepPost,
} from '../lib/collector/deep-analysis-source.ts';
import { scoreDeepAnalysis } from '../lib/collector/deep-analysis.ts';
import {
  deepBodyExcerpt,
  validateDeepAi,
  analyzeDeepPost,
  type DeepAiResult,
} from '../lib/collector/deep-analysis-ai.ts';
import {
  beginDeepRun,
  ingestDeepRun,
  readDeepData,
  readDeepWeekly,
  validateDeepSnapshot,
  handleDeepRequest,
} from '../lib/collector/deep-analysis-store.ts';
import { testDb } from './d1-test-db.ts';
import relayWorker from '../cloudflare/collector-worker.ts';

const now = Date.parse('2026-09-07T12:00:00Z');
const iso = (ms = now) => new Date(ms).toISOString();
const post = (id = 'abc', extra: Partial<DeepPost> = {}): DeepPost => ({
  id,
  title: 'VOO allocation research',
  author: 'researcher',
  created_utc: (now - 3600000) / 1000,
  selftext:
    '# Research\n\nVOO VTI VXUS BND QQQ duration inflation factor asset allocation recession\n\n1. Evidence\n\n| Series | Return |\n| --- | --- |\n| 1 | 10% |\n\nhttps://sec.gov/report https://fred.stlouisfed.org/series https://nber.org/paper\n' +
    'There were 10 observations and 5% variation. '.repeat(170),
  subreddit: 'Bogleheads',
  link_flair_text: null,
  author_flair_text: null,
  is_self: true,
  domain: 'self.Bogleheads',
  url: `https://www.reddit.com/r/Bogleheads/comments/${id}/`,
  over_18: false,
  retrieved_on: now / 1000,
  ...extra,
});
const ai = (extra: Partial<DeepAiResult> = {}): DeepAiResult => ({
  title_zh: 'VOO 配置研究',
  type: 'allocation',
  thesis: '作者比较了资产配置方案。',
  key_data: ['观察样本为 10 个。'],
  author_background_claimed: null,
  counterpoints: '原文未充分讨论风险。',
  scores: { reasoning_depth: 3, data_support: 3, reading_value: 3 },
  ...extra,
});
const snapshot = (posts: DeepPost[] = [post()]): DeepDailySnapshot => ({
  collectedAt: iso(),
  requests: 7 + posts.length * 2,
  communities: DEEP_COMMUNITIES.map((subreddit) => ({
    subreddit,
    returned: subreddit === 'Bogleheads' ? posts.length : 0,
  })),
  seenIds: posts.map((p) => String(p.id)),
  authors: [],
  candidates: posts.map((p) => ({
    post: p,
    uniqueCommenters: 7,
    authorLongPosts: 2,
  })),
  finalists: rankDeepCandidates(
    posts.map((p) => ({
      post: p,
      uniqueCommenters: 7,
      authorLongPosts: 2,
    })),
  ),
});
const ok = (data: unknown, headers?: HeadersInit) =>
  Response.json({ data }, { headers });
const noSleep = async () => {};

void test('publication checks use created_utc seconds; exact seven-day edge passes, stale/future/missing dates fail', () => {
  assert.equal(
    deepPublishedMs((now - DEEP_WINDOW_MS) / 1000, now),
    now - DEEP_WINDOW_MS,
  );
  for (const value of [
    undefined,
    null,
    '123',
    NaN,
    Infinity,
    -1,
    now,
    (now + 1) / 1000,
    (now - DEEP_WINDOW_MS - 1) / 1000,
  ])
    assert.equal(deepPublishedMs(value, now), null);
});
void test('Beijing days descend, then score, publication time and ID within the day', () => {
  const values = [
    { id: 'old', publishedAt: iso(now - 10000), score: 100 },
    { id: 'b', publishedAt: iso(), score: 60 },
    { id: 'a', publishedAt: iso(), score: 60 },
    { id: 'new', publishedAt: iso(), score: 70 },
  ];
  assert.deepEqual(
    values.sort(compareDeepRecent).map((p) => p.id),
    ['old', 'new', 'a', 'b'],
  );
});
void test('new badge is based on publication since yesterday Beijing midnight, never collection date', () => {
  const yesterday = Date.parse('2026-09-05T16:00:00Z');
  assert.equal(deepIsNew(iso(yesterday), now), true);
  assert.equal(deepIsNew(iso(yesterday - 1), now), false);
  assert.equal(deepIsNew(iso(now + 1), now), false);
  assert.equal(deepIsNew('invalid', now), false);
});
void test('daily source uses seven 72h searches, ten aggregates then five author badges, 22 requests maximum', async () => {
  const urls: URL[] = [];
  const rows = Array.from({ length: 10 }, (_, i) =>
    post(`p${i}`, {
      author: `author_${i}`,
      created_utc: (now - (i + 1) * 3600000) / 1000,
    }),
  );
  rows.push(
    post('old', { created_utc: (now - 80 * 3600000) / 1000 }),
    post('future', { created_utc: (now + 1) / 1000 }),
    post('missing', { created_utc: null }),
  );
  const mock: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    if (url.pathname.endsWith('/aggregate'))
      return ok([
        { author: 'alice', count: 20 },
        { author: 'ALICE', count: 2 },
        { author: 'bob', count: '4' },
        { author: '[deleted]', count: 3 },
      ]);
    if (url.searchParams.has('author'))
      return ok([
        {
          id: 'history',
          subreddit: 'ETFs',
          created_utc: (now - 86400000) / 1000,
          selftext: 'x'.repeat(1500),
        },
      ]);
    assert.equal(url.searchParams.get('after'), '72h');
    assert.equal(url.searchParams.get('limit'), 'auto');
    assert.equal(url.searchParams.get('sort'), 'desc');
    for (const key of ['fields', 'title', 'query', 'selftext', 'body'])
      assert.equal(url.searchParams.has(key), false);
    return ok(url.searchParams.get('subreddit') === 'Bogleheads' ? rows : []);
  };
  const result = await collectDeepDaily(
    { seenIds: [], authors: [] },
    mock,
    now,
    noSleep,
  );
  assert.equal(result.requests, 22);
  assert.equal(urls.length, 22);
  assert.deepEqual(
    result.finalists.map((f) => f.post.id),
    rows.slice(0, 5).map((p) => p.id),
  );
  assert.ok(
    result.finalists.every(
      (f) => f.uniqueCommenters === 2 && f.authorLongPosts === 1,
    ),
  );
  assert.equal(result.seenIds.includes('p8'), false);
  assert.equal(result.seenIds.includes('future'), false);
  assert.equal(urls[7].searchParams.get('link_id'), 't3_p0');
  assert.equal(urls[7].searchParams.get('limit'), '');
  assert.equal(
    urls[17].searchParams.get('subreddit'),
    DEEP_COMMUNITIES.join(','),
  );
  assert.equal(
    urls[17].searchParams.get('fields'),
    'id,subreddit,created_utc,selftext',
  );
  validateDeepSnapshot(result, now, now);
});
void test('daily collection and server validation share the 20-point queue floor', async () => {
  const accepted = post('at35', {
    selftext: '# Research\nVOO VTI BND\n'.padEnd(1000, 'x'),
  });
  const below = post('below35', {
    selftext: 'VOO '.padEnd(1000, 'x'),
  });
  const result = await collectDeepDaily(
    { seenIds: [], authors: [] },
    async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/aggregate') || url.searchParams.has('author'))
        return ok([]);
      return ok(
        url.searchParams.get('subreddit') === 'Bogleheads'
          ? [accepted, below]
          : [],
      );
    },
    now,
    noSleep,
  );
  assert.deepEqual(
    result.finalists.map((f) => f.post.id),
    ['at35'],
  );
  assert.equal(result.requests, 9);
  assert.doesNotThrow(() => validateDeepSnapshot(result, now, now));
  assert.throws(
    () => validateDeepSnapshot(snapshot([below]), now, now),
    /Ineligible/,
  );
});

void test('seven-day dedup and cached author history avoid repeat enrichment requests', async () => {
  let calls = 0;
  const mock: typeof fetch = async (input) => {
    calls++;
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.pathname.endsWith('aggregate')) return ok([]);
    assert.equal(u.searchParams.has('author'), false);
    return ok(
      u.searchParams.get('subreddit') === 'Bogleheads'
        ? [post('seen'), post('new')]
        : [],
    );
  };
  const result = await collectDeepDaily(
    {
      seenIds: ['seen'],
      authors: [
        { author: 'RESEARCHER', longPosts: 4, checkedAt: iso(now - 86400000) },
      ],
    },
    mock,
    now,
    noSleep,
  );
  assert.equal(calls, 8);
  assert.equal(result.finalists[0].authorLongPosts, 4);
  assert.equal(result.finalists[0].uniqueCommenters, 0);
  assert.equal(result.finalists.length, 1);
});
void test('429 halts source calls, preserving reset; Remaining zero prevents the next network call', async () => {
  let calls = 0;
  await assert.rejects(
    collectDeepDaily(
      { seenIds: [], authors: [] },
      async () => {
        calls++;
        return new Response('', {
          status: 429,
          headers: { 'X-RateLimit-Reset': '30' },
        });
      },
      now,
      noSleep,
    ),
    (e: unknown) => (e as { retryAfter?: string }).retryAfter === '30',
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    collectDeepDaily(
      { seenIds: [], authors: [] },
      async () => {
        calls++;
        return ok([], { 'X-RateLimit-Remaining': '0' });
      },
      now,
      noSleep,
    ),
  );
  assert.equal(calls, 1);
});
void test('supplemental missing metrics stay null instead of claiming no discussion', async () => {
  const result = await collectDeepDaily(
    { seenIds: [], authors: [] },
    async (input) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname.endsWith('aggregate'))
        return new Response('unavailable', { status: 503 });
      return ok(
        u.searchParams.get('subreddit') === 'Bogleheads' ? [post()] : [],
      );
    },
    now,
    noSleep,
  );
  assert.equal(result.finalists[0].uniqueCommenters, null);
});
void test('interaction uses twice log2(1+n); author history has zero weight', () => {
  assert.deepEqual(deepSupplementPoints(7, 3), {
    commenters: 6,
    authorHistory: 0,
  });
  assert.deepEqual(deepSupplementPoints(100000, 50), {
    commenters: 10,
    authorHistory: 0,
  });
  assert.deepEqual(deepSupplementPoints(null, null), {
    commenters: 0,
    authorHistory: 0,
  });
});
void test('AI excerpt is UTF-8 bounded, includes conclusion and never duplicates overlaps', () => {
  const short = '中文'.repeat(1200);
  assert.deepEqual(deepBodyExcerpt(short), {
    head: short,
    tail: '',
    omitted: false,
  });
  const long = '📈中'.repeat(4000) + '结论在这里';
  const out = deepBodyExcerpt(long);
  assert.ok(new TextEncoder().encode(out.head).length <= 9000);
  assert.ok(new TextEncoder().encode(out.tail).length <= 3000);
  assert.ok(out.tail.endsWith('结论在这里'));
  assert.equal((out.head + out.tail).includes('�'), false);
  assert.equal(out.omitted, true);
});
void test('AI result validation requires Chinese and three integer scores from one to five', () => {
  assert.equal(validateDeepAi(ai(), '').scores.reading_value, 3);
  for (const value of [
    ai({ thesis: '文'.repeat(81) }),
    ai({ title_zh: 'English only' }),
    ai({ scores: { reasoning_depth: 6, data_support: 3, reading_value: 3 } }),
    ai({ key_data: ['a', 'b', 'c', 'd'] }),
    ai({ counterpoints: '' }),
  ])
    assert.throws(() => validateDeepAi(value, ''));
});
void test('deep AI succeeds once, includes head/tail and retries provider failure once without switching providers', async () => {
  let calls = 0,
    observed = '';
  const result = await analyzeDeepPost(
    {
      AI: {
        run: async (_model, request) => {
          calls++;
          observed = JSON.stringify(request);
          return { response: JSON.stringify(ai()) };
        },
      },
    },
    post('abc', { selftext: '开头'.repeat(5000) + '结论末尾' }),
  );
  assert.equal(calls, 1);
  assert.equal(result.title_zh, 'VOO 配置研究');
  assert.match(observed, /结论末尾/);
  assert.match(observed, /body_tail/);
  calls = 0;
  await assert.rejects(
    analyzeDeepPost(
      {
        OPENAI_API_KEY: 'must-not-use',
        AI: {
          run: async () => {
            calls++;
            throw new Error('unavailable');
          },
        },
      },
      post(),
    ),
  );
  assert.equal(calls, 2);
});
void test('daily claim is atomic and cannot reset the request budget with another manual dispatch', async () => {
  const t = testDb();
  try {
    const [a, b] = await Promise.all([
      beginDeepRun(t.db, now),
      beginDeepRun(t.db, now),
    ]);
    assert.equal(Number(a.needed) + Number(b.needed), 1);
    assert.equal((await beginDeepRun(t.db, now + 1000)).needed, false);
    assert.equal((await beginDeepRun(t.db, now + 86400000)).needed, true);
  } finally {
    t.close();
  }
});
void test('snapshot rejects forged stale/future timestamps, low-quality posts, excessive requests and missing communities', () => {
  for (const p of [
    post('x', { created_utc: (now - 80 * 3600000) / 1000 }),
    post('x', { created_utc: (now + 1) / 1000 }),
    post('x', { selftext: 'VOO' }),
  ])
    assert.throws(() => validateDeepSnapshot(snapshot([p]), now, now));
  assert.throws(() =>
    validateDeepSnapshot({ ...snapshot(), requests: 26 }, now, now),
  );
  assert.throws(() =>
    validateDeepSnapshot({ ...snapshot(), communities: [] }, now, now),
  );
  assert.throws(() =>
    validateDeepSnapshot(snapshot([post(), post()]), now, now),
  );
});
void test('ingest applies AI gate once, preserves original publication, caps score and stores no article body', async () => {
  const t = testDb();
  try {
    const run = await beginDeepRun(t.db, now);
    let calls = 0;
    const data = snapshot([
      post('pass'),
      post('reject'),
      post('low'),
      post('false'),
      post('fail'),
    ]);
    const result = await ingestDeepRun(
      { DB: t.db },
      run.day,
      run.token!,
      data,
      now,
      async (_env, p) => {
        calls++;
        if (p.id === 'fail') throw new Error('no AI');
        return ai(
          p.id === 'reject'
            ? {
                scores: {
                  reasoning_depth: 1,
                  data_support: 1,
                  reading_value: 1,
                },
              }
            : p.id === 'low'
              ? {
                  scores: {
                    reasoning_depth: 2,
                    data_support: 3,
                    reading_value: 3,
                  },
                }
              : p.id === 'false'
                ? {
                    scores: {
                      reasoning_depth: 3,
                      data_support: 1,
                      reading_value: 2,
                    },
                  }
                : {},
        );
      },
    );
    assert.deepEqual(
      [result.accepted, result.rejected, result.failed],
      [1, 3, 1],
    );
    assert.equal(result.status, 'partial');
    assert.equal(calls, 5);
    const current = await readDeepData(t.db, now);
    assert.equal(current.articles.length, 1);
    assert.equal(current.articles[0].publishedAt, iso(now - 3600000));
    assert.ok(current.articles[0].score <= 100);
    const stored = JSON.stringify(
      t.sqlite.prepare('SELECT * FROM deep_analysis_articles').all(),
    );
    assert.equal(stored.includes('selftext'), false);
    assert.equal(stored.includes('There were 10 observations'), false);
    await assert.rejects(
      ingestDeepRun({ DB: t.db }, run.day, run.token!, data, now, async () => {
        calls++;
        return ai();
      }),
    );
    assert.equal(calls, 5);
    const weekly = await readDeepWeekly(
      t.db,
      iso(now - 86400000),
      iso(now + 1),
    );
    assert.equal(weekly.length, 1);
    assert.equal(JSON.stringify(weekly).includes('researcher'), false);
    assert.equal(JSON.stringify(weekly).includes('reddit.com'), false);
  } finally {
    t.close();
  }
});
void test('public reads enforce a rolling publication window even before cleanup; database index supports sorting', async () => {
  const t = testDb();
  try {
    for (const [id, published, score] of [
      ['old', now - DEEP_WINDOW_MS - 1, 100],
      ['edge', now - DEEP_WINDOW_MS, 80],
      ['future', now + 1, 99],
      ['new', now - 1, 55],
      ['recent', now - 1000, 90],
    ] as const) {
      t.sqlite
        .prepare('INSERT INTO deep_analysis_articles VALUES (?, ?, ?, ?, ?)')
        .run(
          id,
          iso(published),
          iso(),
          score,
          JSON.stringify({ id, score, publishedAt: iso(published) }),
        );
    }
    const result = await readDeepData(t.db, now);
    assert.deepEqual(
      result.articles.map((a) => a.id),
      ['recent', 'new', 'edge'],
    );
    const plan = t.sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM deep_analysis_articles WHERE published_at_utc >= ? AND published_at_utc <= ? ORDER BY published_at_utc DESC, score DESC',
      )
      .all(iso(now - DEEP_WINDOW_MS), iso());
    assert.match(
      JSON.stringify(plan),
      /USING INDEX idx_deep_articles_published_score/,
    );
    await beginDeepRun(t.db, now);
    assert.equal(
      t.sqlite
        .prepare("SELECT id FROM deep_analysis_articles WHERE id = 'old'")
        .get(),
      undefined,
    );
  } finally {
    t.close();
  }
});
void test('deep ingestion persists request-local AI attempts including provider failures', async () => {
  const t = testDb();
  try {
    const run = await beginDeepRun(t.db, now);
    let calls = 0;
    const result = await ingestDeepRun(
      {
        DB: t.db,
        AI: {
          run: async () => {
            if (++calls >= 2) throw new Error('provider unavailable');
            return { response: JSON.stringify(ai()) };
          },
        },
      },
      run.day,
      run.token!,
      snapshot([post('one'), post('two')]),
      now,
    );
    assert.equal(result.aiCalls, 3);
    assert.equal(result.accepted, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.status, 'partial');
    const stored = t.sqlite
      .prepare('SELECT details_json FROM deep_analysis_runs WHERE day = ?')
      .get(run.day);
    assert.equal(JSON.parse(String(stored?.details_json)).aiCalls, 3);
    const publicData = await readDeepData(t.db, now);
    assert.equal(publicData.lastRun?.startedAt, iso());
    assert.equal(publicData.lastRun?.status, 'partial');
    assert.equal('token' in publicData.lastRun!, false);
  } finally {
    t.close();
  }
});
void test('daily cleanup expires only deep seen/author cache and preserves unrelated hourly data', async () => {
  const t = testDb();
  try {
    t.sqlite
      .prepare(
        "INSERT INTO deep_analysis_seen VALUES (?, ?, 'reddit-depth-v2')",
      )
      .run('expired', iso(now - DEEP_WINDOW_MS));
    t.sqlite
      .prepare(
        "INSERT INTO deep_analysis_seen VALUES (?, ?, 'reddit-depth-v2')",
      )
      .run('kept', iso(now - DEEP_WINDOW_MS + 1));
    t.sqlite
      .prepare('INSERT INTO deep_analysis_authors VALUES (?, ?, ?)')
      .run('expired', 5, iso(now - DEEP_WINDOW_MS));
    t.sqlite
      .prepare('INSERT INTO deep_analysis_authors VALUES (?, ?, ?)')
      .run('kept', 2, iso(now - DEEP_WINDOW_MS + 1));
    t.sqlite
      .prepare('INSERT INTO ai_daily_usage VALUES (?, ?)')
      .run('2026-09-07', 17);
    const run = await beginDeepRun(t.db, now);
    assert.deepEqual(run.seenIds, ['kept']);
    assert.equal(run.authors?.length, 1);
    assert.equal(
      t.sqlite.prepare('SELECT requests FROM ai_daily_usage').get()?.requests,
      17,
    );
  } finally {
    t.close();
  }
});
void test('internal endpoint rejects unauthenticated writes, oversized input and stale run tokens', async () => {
  const t = testDb();
  try {
    const req = (body: string, token?: string) =>
      new Request('https://example.com/api/internal/deep-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      });
    const env = { DB: t.db, TITLE_INGEST_TOKEN: 'test-secret' };
    assert.equal(
      (await handleDeepRequest(req('{"action":"begin"}'), env)).status,
      401,
    );
    assert.equal(
      t.sqlite.prepare('SELECT COUNT(*) AS n FROM deep_analysis_runs').get()?.n,
      0,
    );
    assert.equal(
      (await handleDeepRequest(req('x'.repeat(4_000_001), 'test-secret'), env))
        .status,
      413,
    );
    assert.equal(
      (
        await handleDeepRequest(
          req(
            JSON.stringify({
              action: 'ingest',
              day: '2026-09-07',
              token: 'stale',
              snapshot: snapshot(),
            }),
            'test-secret',
          ),
          env,
        )
      ).status,
      422,
    );
  } finally {
    t.close();
  }
});
void test('workflows pin Node 22, expose summaries and use daily plus redundant hourly schedules', () => {
  const daily = readFileSync(
    new URL('../.github/workflows/deep-analysis.yml', import.meta.url),
    'utf8',
  );
  assert.match(daily, /30 0 \* \* \*/);
  assert.match(daily, /workflow_dispatch/);
  assert.match(daily, /TITLE_INGEST_TOKEN/);
  assert.match(daily, /persist-credentials: false/);
  const hourly = readFileSync(
    new URL('../.github/workflows/title-index.yml', import.meta.url),
    'utf8',
  );
  assert.match(hourly, /10 \* \* \* \*/);
  assert.match(hourly, /40 \* \* \* \*/);
  for (const workflow of [daily, hourly]) {
    assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/);
    assert.match(workflow, /node-version: '22'/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /always\(\)/);
  }
  assert.match(hourly, /steps.arctic.outputs.skip_fallback != 'true'/);
  assert.ok(scoreDeepAnalysis(post(), 'reject-matched').finalist);
});

void test('server dedup prevents a second AI request for the same article on another day', async () => {
  const t = testDb();
  try {
    let calls = 0;
    const analyzer = async () => {
      calls++;
      return ai();
    };
    const first = await beginDeepRun(t.db, now);
    await ingestDeepRun(
      { DB: t.db },
      first.day,
      first.token!,
      snapshot(),
      now,
      analyzer,
    );
    const tomorrow = now + 86400000;
    const second = await beginDeepRun(t.db, tomorrow);
    const repeated = { ...snapshot(), collectedAt: iso(tomorrow) };
    const result = await ingestDeepRun(
      { DB: t.db },
      second.day,
      second.token!,
      repeated,
      tomorrow,
      analyzer,
    );
    assert.equal(calls, 1);
    assert.equal(result.accepted, 0);
    const cards = await readDeepData(t.db, tomorrow);
    assert.equal(cards.articles[0].firstSeenAt, iso());
    assert.equal(cards.articles[0].publishedAt, iso(now - 3600000));
  } finally {
    t.close();
  }
});

void test('relay allows the deep excerpt size only for authenticated deep requests; hourly bounds remain unchanged', async () => {
  let calls = 0,
    outputTokens = 0;
  const runtime = {
    SITE_BASE_URL: 'https://example.com',
    JOB_SECRET: 'job',
    AI_RELAY_SECRET: 'relay-secret',
    AI: {
      run: async (_model: string, input: Record<string, unknown>) => {
        calls++;
        outputTokens = Number(input.max_tokens);
        if (outputTokens === 2000) {
          assert.equal(input.raw, true);
          assert.match(
            String(input.prompt),
            /<\|im_start\|>assistant\n<think>\n\n<\/think>\n\n$/,
          );
          assert.equal(input.messages, undefined);
        } else assert.ok(Array.isArray(input.messages));
        return { response: JSON.stringify(ai()) };
      },
    },
  } as unknown as Parameters<typeof relayWorker.fetch>[1];
  const invoke = (
    purpose: string | undefined,
    size: number,
    auth = 'relay-secret',
  ) =>
    relayWorker.fetch(
      new Request('https://relay.example/ai', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          purpose,
          messages: [
            { role: 'system', content: 'Summarize' },
            { role: 'user', content: 'x'.repeat(size) },
          ],
        }),
      }) as Parameters<typeof relayWorker.fetch>[0],
      runtime,
    );
  assert.equal((await invoke('deep_analysis', 12000)).status, 200);
  assert.equal(calls, 1);
  assert.equal(outputTokens, 2000);
  assert.equal((await invoke(undefined, 12000)).status, 413);
  assert.equal((await invoke('deep_analysis', 18001)).status, 413);
  assert.equal((await invoke('unknown', 100)).status, 400);
  assert.equal((await invoke('deep_analysis', 12000, 'wrong')).status, 401);
  assert.equal(calls, 1);
  assert.equal((await invoke(undefined, 100)).status, 200);
  assert.equal(outputTokens, 1000);
});
