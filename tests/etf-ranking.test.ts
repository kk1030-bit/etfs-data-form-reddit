import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  extractEtfTickers,
  beginnerFlairPenalty,
  indexedCommentGrowth,
  scoreCandidates,
  selectTopStories,
  logicalHourIso,
  type RedditCandidate,
} from '../lib/collector/core.ts';
import {
  aggregateTargets,
  fetchIndexedCommentCount,
  collectIndexedCommentCounts,
  createArcticFetcher,
  normalizeIndexedPost,
} from '../lib/collector/arctic-shift.ts';
import {
  parseArcticSnapshot,
  type ArcticSnapshot,
} from '../lib/collector/arctic-snapshot.ts';
import { runHourly } from '../lib/collector/jobs.ts';
import { RedditRssError } from '../lib/collector/reddit-rss.ts';
import {
  commentGrowthLabel,
  commentMetricLabel,
} from '../lib/comment-metric.ts';
import { testDb } from './d1-test-db.ts';

const base = Date.parse(logicalHourIso(Date.now())) - 4 * 3_600_000;
const iso = (hours = 0) => new Date(base + hours * 3_600_000).toISOString();
const raw = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subreddit: 'ETFs',
  author: `author_${id}`,
  title: 'VOO vs VTI ETF comparison',
  selftext: 'ETF fees and diversification',
  created_utc: (base - 3600000) / 1000,
  ...extra,
});
const candidate = (
  id: string,
  extra: Partial<RedditCandidate> = {},
): RedditCandidate => ({
  ...normalizeIndexedPost(raw(id))!,
  ...extra,
});
const observation = (count: number, hour = 0) => ({
  count,
  observedAtUtc: iso(hour),
});
const details = () => ({
  provider: 'Arctic Shift',
  communities: ['ETFs'],
  warnings: [] as string[],
  newestPostAt: iso(-1),
  newestIndexedAt: iso(),
  commentSampleSize: 0,
});

void test('ETF symbols come only from title/body allowlist, never ordinary capitals or substrings', () => {
  assert.deepEqual(
    extractEtfTickers('VOO / vti / $QQQM', 'VOO, SCHG and JEPI'),
    ['VOO', 'VTI', 'QQQM', 'SCHG', 'JEPI'],
  );
  assert.deepEqual(
    extractEtfTickers('ETF IRA FIRE USD NVDA MSFT MYVOO VTI2'),
    [],
  );
  assert.equal(
    normalizeIndexedPost(
      raw('flair', {
        link_flair_text: 'Beginner',
        title: 'AVDV fees',
        subreddit: 'investing',
      }),
    )?.flair,
    'Beginner',
  );
});

void test('only beginner/help flairs receive the explicit 40% penalty', () => {
  for (const flair of [
    'Beginner',
    'Beginners',
    'Rate my portfolio',
    'Portfolio Review',
    'Portfolio help',
    'Getting started',
  ])
    assert.equal(beginnerFlairPenalty(flair), 0.6);
  for (const flair of [
    undefined,
    'Discussion',
    'ETF Analysis',
    'Portfolio strategy',
    'News',
  ])
    assert.equal(beginnerFlairPenalty(flair), 1);
  const common = { indexedComments: observation(30) };
  const ranked = scoreCandidates(
    [
      candidate('help', { ...common, flair: 'Beginner' }),
      candidate('research', common),
    ],
    base,
  );
  assert.equal(ranked[0].id, 't3_research');
  assert.ok(Math.abs(ranked[1].heatScore / ranked[0].heatScore - 0.6) < 0.01);
});

void test('Top 5 reserves three ticker seats despite higher generic heat, in final heat order', () => {
  const posts = Array.from({ length: 8 }, (_, i) =>
    candidate(`q${i}`, {
      title: i < 5 ? 'How do I start investing in ETFs?' : 'VOO expense ratio',
      body: '',
      indexedComments: observation(i < 5 ? 100 : 1),
    }),
  );
  const ranked = scoreCandidates(posts, base);
  const selected = selectTopStories(ranked);
  assert.equal(selected.length, 5);
  assert.equal(
    selected.filter((p) => extractEtfTickers(p.title, p.body).length).length,
    3,
  );
  assert.deepEqual(
    selected.map((p) => p.heatScore),
    selected.map((p) => p.heatScore).sort((a, b) => b - a),
  );
  const shortage = selectTopStories(ranked.filter((p) => p.id !== 't3_q7'));
  assert.equal(shortage.length, 5);
  assert.equal(
    shortage.filter((p) => extractEtfTickers(p.title, p.body).length).length,
    2,
  );
});

void test('ticker reservation never bypasses two-per-author limit, including relaxed fill', () => {
  const ranked = scoreCandidates(
    Array.from({ length: 8 }, (_, i) =>
      candidate(`cap${i}`, {
        author: i < 6 ? 'same' : `other${i}`,
        indexedComments: observation(10),
      }),
    ),
    base,
  );
  const selected = selectTopStories(ranked);
  assert.equal(selected.filter((p) => p.author === 'same').length, 2);
  assert.equal(selected.length, 4);
});

void test('hourly indexed growth wins over a large stagnant lifetime count; samples cannot change new ranking', () => {
  const posts = [
    candidate('stale', {
      indexedComments: observation(300, 1),
      discussionCount: 600,
    }),
    candidate('rising', {
      indexedComments: observation(30, 1),
      discussionCount: 0,
    }),
  ];
  const prior = new Map(
    posts.map((p) => [
      p.id,
      {
        score: 0,
        comments: 999,
        observedAtUtc: iso(),
        bestListingRank: null,
        indexedComments: observation(p.id === 't3_stale' ? 300 : 10),
      },
    ]),
  );
  const ranked = scoreCandidates(posts, base + 3600000, prior);
  assert.equal(ranked[0].id, 't3_rising');
  assert.equal(ranked[0].velocityScore, 20);
  assert.equal(ranked[1].velocityScore, 0);
  assert.deepEqual(ranked[0].commentGrowth, {
    delta: 20,
    hours: 1,
    perHour: 20,
  });
  assert.equal(
    scoreCandidates(
      posts.map((p) => ({ ...p, discussionCount: 0 })),
      base + 3600000,
      prior,
    )[0].heatScore,
    ranked[0].heatScore,
  );
});

void test('first baseline, unknown counts, too-short intervals and downward corrections do not invent growth', () => {
  assert.equal(indexedCommentGrowth(observation(10)), null);
  assert.equal(indexedCommentGrowth(undefined, observation(10)), null);
  assert.equal(indexedCommentGrowth(observation(9, 1), observation(10)), null);
  assert.equal(
    indexedCommentGrowth(observation(20, 0.01), observation(10)),
    null,
  );
  assert.deepEqual(indexedCommentGrowth(observation(34, 3), observation(10)), {
    delta: 24,
    hours: 3,
    perHour: 8,
  });
  const legacy = new Map([
    [
      't3_old',
      { score: 0, comments: 8, observedAtUtc: iso(), bestListingRank: null },
    ],
  ]);
  assert.equal(
    scoreCandidates(
      [candidate('old', { indexedComments: observation(40, 1) })],
      base + 3600000,
      legacy,
    )[0].commentGrowth,
    null,
  );
});

void test('shortlist has at most 40 new IDs plus every tracked ID; duplicates consume one request', () => {
  const tracked = Array.from({ length: 120 }, (_, i) => `t3_tracked${i}`);
  const posts = Array.from({ length: 600 }, (_, i) => candidate(`new${i}`));
  const targets = aggregateTargets(
    [...posts, candidate('tracked0')],
    [...tracked, tracked[0], 'bad'],
  );
  assert.equal(targets.length, 160);
  assert.deepEqual(targets.slice(0, 120), tracked);
  assert.equal(new Set(targets).size, targets.length);
});

void test('per-post aggregate filters link_id, no body/window; accepts string count beyond old 600 sample bound', async () => {
  const metric = await fetchIndexedCommentCount(
    't3_test',
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.pathname, '/api/comments/search/aggregate');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        link_id: 't3_test',
        aggregate: 'subreddit',
        limit: '1',
      });
      assert.equal(init?.redirect, 'manual');
      assert.match(
        new Headers(init?.headers).get('User-Agent')!,
        /etfs-hot-topics/,
      );
      return Response.json({ data: [{ key: 'ETFs', count: '1200' }] });
    },
    () => base,
  );
  assert.deepEqual(metric, observation(1200));
  assert.deepEqual(
    await fetchIndexedCommentCount(
      't3_zero',
      async () => Response.json({ data: [] }),
      () => base,
    ),
    observation(0),
  );
});

void test('malformed, HTML, empty and failed aggregate responses are unknown, not zero', async () => {
  for (const count of [
    null,
    '',
    '1.5',
    '-1',
    -1,
    '1e3',
    10000001,
    true,
    undefined,
  ])
    await assert.rejects(
      fetchIndexedCommentCount('t3_bad', async () =>
        Response.json({ data: [{ count }] }),
      ),
      /Invalid/,
    );
  for (const response of [
    new Response('HTML'),
    new Response(null),
    new Response('', { status: 503 }),
    Response.json({ data: [null] }),
  ])
    await assert.rejects(
      fetchIndexedCommentCount('t3_bad', async () => response),
    );
});

void test('all aggregate requests use shared pacing, including tracked IDs and zero remaining stop', async () => {
  let clock = base;
  const seen: string[] = [];
  const waits: number[] = [];
  const paced = createArcticFetcher(
    async (input) => {
      seen.push(
        new URL(input instanceof Request ? input.url : input).searchParams.get(
          'link_id',
        )!,
      );
      return Response.json({ data: [{ count: '12' }] });
    },
    async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    () => clock,
  );
  const info = details();
  const counts = await collectIndexedCommentCounts(
    [candidate('new'), candidate('tracked')],
    ['t3_tracked'],
    info,
    paced,
    () => clock,
  );
  assert.deepEqual(seen, ['t3_tracked', 't3_new']);
  assert.deepEqual(waits, [2000]);
  assert.equal(counts.size, 2);
  assert.equal(info.commentSampleSize, 0);
  let calls = 0;
  const exhausted = createArcticFetcher(
    async () => {
      calls++;
      return Response.json(
        { data: [] },
        {
          headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '29' },
        },
      );
    },
    async () => {},
    () => base,
  );
  await assert.rejects(
    collectIndexedCommentCounts(
      [candidate('one'), candidate('two')],
      [],
      details(),
      exhausted,
    ),
    (e: unknown) =>
      e instanceof RedditRssError && e.status === 429 && e.retryAfter === '29',
  );
  assert.equal(calls, 1);
});

void test('partial aggregate failures preserve coverage, never fabricate zeros; all failed prevents ranking', async () => {
  const info = details();
  const fetcher: typeof fetch = async (input) =>
    new URL(input instanceof Request ? input.url : input).searchParams.get(
      'link_id',
    ) === 't3_bad'
      ? new Response('', { status: 503 })
      : Response.json({ data: [{ count: '4' }] });
  const counts = await collectIndexedCommentCounts(
    [candidate('good'), candidate('bad')],
    [],
    info,
    fetcher,
  );
  assert.equal(counts.has('t3_bad'), false);
  assert.equal(counts.get('t3_good')?.count, 4);
  assert.ok(info.warnings.some((s) => s.includes('1/2')));
  await assert.rejects(
    collectIndexedCommentCounts([candidate('bad')], [], details(), fetcher),
    /unavailable/,
  );
});

void test('ingestion validates aggregate totals independently from samples and re-extracts flair/tickers', () => {
  const input = {
    candidates: [
      candidate('test', { flair: 'Beginner', etfTickers: ['FAKE'] }),
    ],
    trackedRaw: [],
    commentCounts: [],
    commentAggregates: [['t3_test', observation(1200)]],
    details: details(),
  };
  const snapshot = parseArcticSnapshot(input, {}, base);
  assert.equal(snapshot.candidates[0].indexedComments?.count, 1200);
  assert.deepEqual(snapshot.candidates[0].etfTickers, ['VOO', 'VTI']);
  assert.equal(snapshot.candidates[0].flair, 'Beginner');
  assert.equal(snapshot.details.aggregateSucceeded, 1);
  assert.equal(snapshot.details.commentSampleSize, 0);
  for (const entries of [
    [['t3_test', observation(-1)]],
    [['t3_test', observation(2, 1)]],
    [['t3_test', observation(2, -1)]],
    [
      ['t3_test', observation(2)],
      ['t3_test', observation(3)],
    ],
    [['bad', observation(3)]],
    Array.from({ length: 161 }, (_, i) => [`t3_${i}`, observation(3)]),
  ])
    assert.throws(
      () =>
        parseArcticSnapshot({ ...input, commentAggregates: entries }, {}, base),
      /aggregate/,
    );
  const old = parseArcticSnapshot(
    { ...input, commentAggregates: undefined, commentCounts: [['t3_test', 8]] },
    {},
    base,
  );
  assert.equal(old.commentAggregates, undefined);
  assert.equal(old.candidates[0].indexedComments, undefined);
});

void test('an uncounted tracked post stays tracked but gets neither a fabricated observation nor a ranking', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const env = {
    DB: fixture.db,
    REDDIT_SOURCE_MODE: 'arctic-shift',
    REDDIT_SUBREDDITS: 'ETFs',
  };
  const initial: ArcticSnapshot = {
    candidates: [candidate('unknown')],
    trackedRaw: [],
    commentCounts: [],
    commentAggregates: [['t3_unknown', observation(24)]],
    details: details(),
  };
  assert.equal((await runHourly(env, base, { snapshot: initial })).selected, 1);
  const next: ArcticSnapshot = {
    candidates: [candidate('unknown'), candidate('known')],
    trackedRaw: [],
    commentCounts: [],
    commentAggregates: [['t3_known', observation(4, 1)]],
    details: details(),
  };
  assert.equal(
    (await runHourly(env, base + 3600000, { snapshot: next })).selected,
    1,
  );
  assert.equal(
    fixture.sqlite
      .prepare('SELECT COUNT(*) AS n FROM post_observations WHERE post_id = ?')
      .get('t3_unknown')?.n,
    1,
  );
  assert.equal(
    fixture.sqlite
      .prepare('SELECT status FROM tracking_episodes WHERE post_id = ?')
      .get('t3_unknown')?.status,
    'active',
  );
  assert.equal(
    fixture.sqlite
      .prepare(
        'SELECT COUNT(*) AS n FROM hourly_rankings WHERE post_id = ? AND logical_hour_utc = ?',
      )
      .get('t3_unknown', iso(1))?.n,
    0,
  );
});

void test('aggregate time budget stops further requests and truthfully reports partial coverage', async () => {
  let clock = base;
  let calls = 0;
  const info = details();
  const counts = await collectIndexedCommentCounts(
    [candidate('one'), candidate('two')],
    [],
    info,
    async () => {
      calls++;
      clock += 100;
      return Response.json({ data: [] });
    },
    () => clock,
    100,
  );
  assert.equal(calls, 1);
  assert.equal(counts.size, 1);
  assert.ok(info.warnings.some((s) => s.includes('1/2')));
});

async function exerciseTrackedCounts(db: D1Database) {
  const env = {
    DB: db,
    REDDIT_SOURCE_MODE: 'arctic-shift',
    REDDIT_SUBREDDITS: 'ETFs',
    ARCTIC_SHIFT_EXTERNAL: '1',
  };
  const snapshot = (
    hour: number,
    oldCount: number,
    newIds: string[] = [],
  ): ArcticSnapshot => ({
    candidates: (newIds.length ? newIds : ['old']).map((id) => candidate(id)),
    trackedRaw: newIds.length ? [{ kind: 't3', data: raw('old') }] : [],
    commentCounts: [],
    commentAggregates: [
      ['t3_old', observation(oldCount, hour)],
      ...newIds.map((id): [string, ReturnType<typeof observation>] => [
        `t3_${id}`,
        observation(40, hour),
      ]),
    ],
    details: { ...details(), commentMetric: 'indexed-total' },
  });
  assert.equal(
    (await runHourly(env, base, { snapshot: snapshot(0, 24) })).selected,
    1,
  );
  const second = await runHourly(env, base + 3600000, {
    snapshot: snapshot(1, 30, ['a', 'b', 'c', 'd', 'e']),
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.selected, 5);
  assert.equal(
    (
      await db
        .prepare(
          'SELECT COUNT(*) AS n FROM hourly_rankings WHERE post_id = ?1 AND logical_hour_utc = ?2',
        )
        .bind('t3_old', iso(1))
        .first<{ n: number }>()
    )?.n,
    0,
  );
  const observed = await db
    .prepare(
      'SELECT * FROM post_observations WHERE post_id = ?1 AND observed_hour_utc = ?2',
    )
    .bind('t3_old', iso(1))
    .first<Record<string, unknown>>();
  assert.equal(observed?.indexed_comment_count, 30);
  assert.equal(observed?.comment_delta, 6);
  assert.equal(observed?.comment_interval_hours, 1);
  assert.equal(observed?.velocity_score, 6);
  // Hour 2 is missing: the next comparison uses elapsed 2h, not an imaginary 1h.
  assert.equal(
    (
      await runHourly(env, base + 3 * 3600000, {
        snapshot: {
          ...snapshot(3, 46, ['a', 'b', 'c', 'd', 'e']),
          trackedRaw: [],
        },
      })
    ).status,
    'completed',
  );
  const third = await db
    .prepare(
      'SELECT * FROM post_observations WHERE post_id = ?1 AND observed_hour_utc = ?2',
    )
    .bind('t3_old', iso(3))
    .first<Record<string, unknown>>();
  assert.equal(third?.indexed_comment_count, 46);
  assert.equal(third?.comment_delta, 16);
  assert.equal(third?.comment_interval_hours, 2);
  assert.equal(third?.velocity_score, 8);
  const first = await db
    .prepare(
      'SELECT comment_delta FROM post_observations WHERE post_id = ?1 AND observed_hour_utc = ?2',
    )
    .bind('t3_old', iso())
    .first<{ comment_delta: number | null }>();
  assert.equal(first?.comment_delta, null);
}

void test('real hourly ingestion persists dropped-out tracker observations and gap-aware growth', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  await exerciseTrackedCounts(fixture.db);
});

void test('migration, JSON upserts and previous-count queries work in actual Cloudflare D1', async (t) => {
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
  for (const name of readdirSync(directory)
    .filter((s) => s.endsWith('.sql'))
    .sort())
    for (const sql of readFileSync(new URL(name, directory), 'utf8')
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  await exerciseTrackedCounts(db as unknown as D1Database);
});

void test('metric labels separate baseline/legacy samples from actual interval growth', () => {
  assert.match(commentMetricLabel({ discussionCount: 8 }), /旧版/);
  assert.match(commentMetricLabel({ indexedCommentCount: 0 }), /总数 0/);
  assert.match(commentGrowthLabel({ indexedCommentCount: 24 }), /待下次/);
  const label = commentGrowthLabel({
    indexedCommentCount: 48,
    commentDelta: 24,
    commentIntervalHours: 3,
  });
  assert.match(label, /3.0 小时/);
  assert.match(label, /8.0 条\/小时/);
});
