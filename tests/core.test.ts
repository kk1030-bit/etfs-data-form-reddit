import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateEtfRelevance,
  canonicalRedditPermalink,
  chunksForD1,
  clampRawRetentionHours,
  containsRedditUserHandle,
  cleanRedditMarkdown,
  logicalHourIso,
  normalizeRedditPost,
  previousBeijingDayWindow,
  previousBeijingWeekWindow,
  scoreCandidates,
  safeReportTopicLabels,
  selectTopStories,
  type RedditCandidate,
} from '../lib/collector/core.ts';
import {
  buildRedditRssUrl,
  fetchRedditRssCandidates,
  parseRedditAtomFeed,
} from '../lib/collector/reddit-rss.ts';
import { analyzePost, hasLlmProvider } from '../lib/collector/llm.ts';

void test('D1 chunks never exceed the 100 bound-parameter limit', () => {
  assert.deepEqual(
    chunksForD1(Array.from({ length: 125 }, (_, index) => index)).map(
      (chunk) => chunk.length,
    ),
    [100, 25],
  );
  assert.deepEqual(
    chunksForD1(
      Array.from({ length: 40 }, (_, index) => index),
      6,
    ).map((chunk) => chunk.length),
    [16, 16, 8],
  );
  assert.throws(() => chunksForD1([1], 101), /cannot exceed 100/);
});

void test('raw Reddit content retention is clamped to 24-48 hours', () => {
  assert.equal(clampRawRetentionHours(), 48);
  assert.equal(clampRawRetentionHours('12'), 24);
  assert.equal(clampRawRetentionHours('36.9'), 36);
  assert.equal(clampRawRetentionHours('72'), 48);
  assert.equal(clampRawRetentionHours('invalid'), 48);
});

void test('historical report topics reject direct account handles', () => {
  assert.equal(containsRedditUserHandle('u/private_author says buy'), true);
  assert.equal(containsRedditUserHandle('@private_author'), true);
  assert.equal(
    containsRedditUserHandle('https://reddit.com/user/private_author'),
    true,
  );
  assert.equal(containsRedditUserHandle('global ETF allocation'), false);
  assert.deepEqual(
    safeReportTopicLabels(
      JSON.stringify([
        '全球配置',
        ' u/private_author ',
        '@another_user',
        'private_author',
        'https://reddit.com/user/private_author',
        '债券   久期',
      ]),
      ['private_author'],
    ),
    ['全球配置', '债券 久期'],
  );
});

function candidate(overrides: Partial<RedditCandidate> = {}): RedditCandidate {
  return {
    id: 't3_abc123',
    redditId: 'abc123',
    subreddit: 'ETFs',
    author: 'indexer',
    permalink: 'https://www.reddit.com/r/ETFs/comments/abc123/',
    outboundUrl: null,
    title: 'ETF allocation question',
    body: 'Comparing VTI and VT for a long term portfolio.',
    createdAtUtc: '2026-09-01T10:00:00.000Z',
    score: 100,
    comments: 20,
    upvoteRatio: 0.9,
    metricsAvailable: true,
    bestListingRank: 1,
    listingKinds: ['hot'],
    relevance: 0.9,
    ...overrides,
  };
}

void test('canonicalRedditPermalink accepts only the expected Reddit submission', () => {
  assert.equal(
    canonicalRedditPermalink(
      '/r/ETFs/comments/AbC123/a_slug/?utm_source=x',
      'abc123',
    ),
    'https://www.reddit.com/r/ETFs/comments/abc123/',
  );
  assert.equal(
    canonicalRedditPermalink(
      'https://reddit.com/r/ETFs/comments/abc123/',
      'abc123',
    ),
    'https://www.reddit.com/r/ETFs/comments/abc123/',
  );
  assert.equal(
    canonicalRedditPermalink(
      'https://reddit.com.evil.example/r/ETFs/comments/abc123/',
      'abc123',
    ),
    null,
  );
  assert.equal(
    canonicalRedditPermalink(
      'https://reddit.com@evil.example/r/ETFs/comments/abc123/',
      'abc123',
    ),
    null,
  );
  assert.equal(
    canonicalRedditPermalink(
      'http://www.reddit.com/r/ETFs/comments/abc123/',
      'abc123',
    ),
    null,
  );
  assert.equal(
    canonicalRedditPermalink(
      'https://www.reddit.com:444/r/ETFs/comments/abc123/',
      'abc123',
    ),
    null,
  );
  assert.equal(
    canonicalRedditPermalink(
      'https://www.reddit.com/r/ETFs/comments/wrong/',
      'abc123',
    ),
    null,
  );
});

void test('normalizeRedditPost keeps but never follows an outbound URL', () => {
  const normalized = normalizeRedditPost(
    {
      kind: 't3',
      data: {
        id: 'abc123',
        permalink: '/r/ETFs/comments/abc123/example/',
        subreddit: 'ETFs',
        author: 'indexer',
        title: 'Which ETF allocation works for VTI and VXUS?',
        selftext: 'Looking at ETF expense ratios.',
        created_utc: 1_788_260_400,
        score: 150,
        num_comments: 30,
        upvote_ratio: 0.92,
        is_self: false,
        url: 'https://outside.example/article',
      },
    },
    'hot',
    2,
  );
  assert.ok(normalized);
  assert.equal(normalized.outboundUrl, 'https://outside.example/article');
  assert.equal(
    normalized.permalink,
    'https://www.reddit.com/r/ETFs/comments/abc123/',
  );
});

void test('unsafe, removed and non-ETF submissions are rejected', () => {
  const base = {
    kind: 't3',
    data: {
      id: 'abc123',
      permalink: '/r/ETFs/comments/abc123/example/',
      subreddit: 'ETFs',
      author: 'indexer',
      title: 'A broad ETF question',
      selftext: 'ETF allocation',
      created_utc: 1_788_260_400,
      score: 1,
      num_comments: 1,
      upvote_ratio: 0.5,
      is_self: true,
    },
  };
  assert.equal(
    normalizeRedditPost(
      { ...base, data: { ...base.data, over_18: true } },
      'hot',
      1,
    ),
    null,
  );
  assert.equal(
    normalizeRedditPost(
      { ...base, data: { ...base.data, removed_by_category: 'moderator' } },
      'hot',
      1,
    ),
    null,
  );
  assert.equal(
    normalizeRedditPost(
      {
        ...base,
        data: {
          ...base.data,
          title: 'Gardening tips',
          selftext: '',
          subreddit: 'gardening',
        },
      },
      'hot',
      1,
    ),
    null,
  );
});

void test('ETF relevance recognizes explicit terms without matching ticker substrings', () => {
  assert.ok(calculateEtfRelevance('VTI or VT ETF?', '', 'investing') >= 0.65);
  assert.equal(
    calculateEtfRelevance('It is time', 'ordinary conversation', 'casual'),
    0,
  );
});

void test('ranking is deterministic and handles first observations', () => {
  const values = [
    candidate({
      id: 't3_a',
      redditId: 'a',
      score: 20,
      comments: 4,
      bestListingRank: 4,
    }),
    candidate({
      id: 't3_b',
      redditId: 'b',
      score: 300,
      comments: 50,
      bestListingRank: 1,
    }),
    candidate({
      id: 't3_c',
      redditId: 'c',
      score: -2,
      comments: 0,
      bestListingRank: 8,
    }),
  ];
  const first = scoreCandidates(values, Date.parse('2026-09-01T12:00:00Z'));
  const second = scoreCandidates(values, Date.parse('2026-09-01T12:00:00Z'));
  assert.deepEqual(
    first.map((item) => item.id),
    second.map((item) => item.id),
  );
  assert.equal(first[0].id, 't3_b');
  assert.ok(
    first.every(
      (item) =>
        Number.isFinite(item.heatScore) && Number.isFinite(item.velocityScore),
    ),
  );
});

void test('top selection caps author and subreddit concentration', () => {
  const ranked = scoreCandidates(
    Array.from({ length: 8 }, (_, index) =>
      candidate({
        id: `t3_${index}`,
        redditId: String(index),
        author: index < 4 ? 'same_author' : `author_${index}`,
        subreddit: index < 5 ? 'ETFs' : `community_${index}`,
        score: 500 - index,
        comments: 100 - index,
      }),
    ),
    Date.parse('2026-09-01T12:00:00Z'),
  );
  const selected = selectTopStories(ranked, 5);
  assert.equal(selected.length, 5);
  assert.ok(
    selected.filter((item) => item.author === 'same_author').length <= 2,
  );
  assert.ok(selected.filter((item) => item.subreddit === 'ETFs').length <= 3);
});

void test('logical hours and Beijing report windows use scheduler time', () => {
  assert.equal(
    logicalHourIso(Date.parse('2026-09-01T12:47:33Z')),
    '2026-09-01T12:00:00.000Z',
  );
  assert.deepEqual(
    previousBeijingDayWindow(Date.parse('2026-09-01T16:05:00Z')),
    {
      label: '2026-09-01',
      startUtc: '2026-08-31T16:00:00.000Z',
      endUtc: '2026-09-01T16:00:00.000Z',
    },
  );
  assert.deepEqual(
    previousBeijingWeekWindow(Date.parse('2026-09-06T16:10:00Z')),
    {
      label: '2026-08-31',
      startUtc: '2026-08-30T16:00:00.000Z',
      endUtc: '2026-09-06T16:00:00.000Z',
    },
  );
});

void test('markdown cleaner removes control data and bounds prompt size', () => {
  const cleaned = cleanRedditMarkdown(
    `hello\u0000\n\n\n\n\nworld<!--ignore-->`,
    20,
  );
  assert.equal(cleaned, 'hello\n\n\nworld');
  assert.ok(cleanRedditMarkdown('x'.repeat(30), 10).length === 10);
});

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <author><name>/u/indexer</name></author>
    <category term="ETFs" label="r/ETFs"/>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Comparing VTI &amp;amp; VT expense ratios.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by /u/indexer</content>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/ETFs/comments/abc123/example/" />
    <published>2026-09-02T01:00:00+00:00</published>
    <title>Which ETF&amp;#39;s allocation works?</title>
  </entry>
  <entry>
    <author><name>/u/indexer</name></author>
    <category term="ETFs"/>
    <content type="html"></content>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/ETFs/comments/abc123/duplicate/" />
    <published>2026-09-02T01:00:00+00:00</published>
    <title>Duplicate ETF entry</title>
  </entry>
  <entry>
    <author><name>/u/attacker</name></author>
    <category term="ETFs"/>
    <content type="html"></content>
    <id>t3_evil1</id>
    <link href="https://reddit.com.evil.example/r/ETFs/comments/evil1/" />
    <published>2026-09-02T01:00:00+00:00</published>
    <title>ETF redirect</title>
  </entry>
  <entry>
    <author><name>/u/gardener</name></author>
    <category term="gardening"/>
    <content type="html"></content>
    <id>t3_irrelevant</id>
    <link href="https://www.reddit.com/r/gardening/comments/irrelevant/" />
    <published>2026-09-02T01:00:00+00:00</published>
    <title>Growing tomatoes</title>
  </entry>
</feed>`;

void test('RSS URL is constructed only from subreddit names', () => {
  assert.equal(
    buildRedditRssUrl({
      REDDIT_SUBREDDITS: 'ETFs,investing,https://evil.example',
      REDDIT_RSS_SORT: 'top',
    }).toString(),
    'https://www.reddit.com/r/ETFs+investing/top/.rss?limit=100&t=day',
  );
  assert.throws(
    () => buildRedditRssUrl({ REDDIT_SUBREDDITS: 'https://evil.example' }),
    /白名单/,
  );
});

void test('Atom parser extracts safe ETF entries and cleans encoded HTML', () => {
  const parsed = parseRedditAtomFeed(ATOM_FIXTURE);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 't3_abc123');
  assert.equal(parsed[0].title, "Which ETF's allocation works?");
  assert.equal(parsed[0].body, 'Comparing VTI & VT expense ratios.');
  assert.equal(parsed[0].metricsAvailable, false);
  assert.equal(parsed[0].bestListingRank, 1);
  assert.equal(parsed[0].outboundUrl, null);
  assert.equal(parsed[0].body.includes('submitted by'), false);
});

void test('RSS fetch rejects rate limits and non-Atom responses without retrying', async () => {
  let calls = 0;
  const limited = (async () => {
    calls += 1;
    return new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '3600' },
    });
  }) as typeof fetch;
  await assert.rejects(
    fetchRedditRssCandidates({}, limited),
    /rate limited.*retry-after=3600/,
  );
  assert.equal(calls, 1);

  const html = (async () =>
    new Response('<html>blocked</html>', {
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
  await assert.rejects(fetchRedditRssCandidates({}, html), /content-type/);
});

void test('RSS fetch never follows a cross-origin redirect', async () => {
  let calls = 0;
  const redirected = (async (_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/stolen.xml' },
    });
  }) as typeof fetch;
  await assert.rejects(
    fetchRedditRssCandidates({}, redirected),
    /redirect target validation failed/,
  );
  assert.equal(calls, 1);
});

void test('RSS candidates use feed ranking without fake engagement percentiles', () => {
  const base = parseRedditAtomFeed(ATOM_FIXTURE)[0];
  const ranked = scoreCandidates(
    [
      base,
      {
        ...base,
        id: 't3_second',
        redditId: 'second',
        author: 'second_author',
        permalink: 'https://www.reddit.com/r/ETFs/comments/second/',
        bestListingRank: 20,
      },
    ],
    Date.parse('2026-09-02T02:00:00Z'),
  );
  assert.equal(ranked[0].id, 't3_abc123');
  assert.ok(ranked.every((item) => item.components.engagement === 0));
});

void test('Workers AI binding adapter parses fenced structured output', async () => {
  const env = {
    AI: {
      async run() {
        return {
          response: `\`\`\`json\n${JSON.stringify({
            title_zh: 'ETF 配置问题',
            translation_zh: '比较 VTI 与 VT。',
            summary_zh: '作者比较两种全球配置方式。',
            highlights: ['关注地区权重', '比较费用与分散度'],
            topics: ['全球配置', 'VTI 与 VT'],
          })}\n\`\`\``,
        };
      },
    },
  };
  assert.equal(hasLlmProvider(env), true);
  const analysis = await analyzePost(env, candidate());
  assert.equal(analysis?.titleZh, 'ETF 配置问题');
  assert.deepEqual(analysis?.highlights, ['关注地区权重', '比较费用与分散度']);
});
