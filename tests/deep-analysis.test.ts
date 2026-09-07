import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreDeepAnalysis } from '../lib/collector/deep-analysis.ts';
import {
  collectDeepBackfill,
  DEEP_POST_FIELDS,
  type DeepPost,
} from '../lib/collector/deep-analysis-source.ts';
import { RedditRssError } from '../lib/collector/reddit-rss.ts';

const base = Date.now();
function post(overrides: Partial<DeepPost> = {}): DeepPost {
  return {
    id: 'abc123',
    subreddit: 'Bogleheads',
    title: 'Portfolio construction research',
    selftext: 'VOO ' + 'x'.repeat(1800),
    author: 'researcher',
    created_utc: (base - 3600000) / 1000,
    link_flair_text: 'Investment Theory',
    author_flair_text: null,
    is_self: true,
    domain: 'self.Bogleheads',
    url: 'https://www.reddit.com/r/Bogleheads/comments/abc123/',
    over_18: false,
    retrieved_on: base / 1000,
    ...overrides,
  };
}
const score = (item: DeepPost) => scoreDeepAnalysis(item, 'reject-matched');

void test('the topic gate uses body-only whole uppercase fund symbols or three distinct macro terms', () => {
  assert.equal(
    score(
      post({ title: 'VOO research', selftext: 'Unrelated company earnings' }),
    ).eligible,
    false,
  );
  assert.equal(
    score(
      post({
        selftext: 'A good tip does not mean TIP is mentioned'.replace(
          'TIP',
          'an ETF',
        ),
      }),
    ).eligible,
    false,
  );
  assert.equal(
    score(post({ selftext: 'Comparing VOO with VTI and VXUS' })).eligible,
    true,
  );
  assert.equal(
    score(post({ selftext: 'The Fed discussed CPI and inflation' })).eligible,
    true,
  );
  assert.equal(score(post({ selftext: 'Fed Fed Fed' })).eligible, false);
  assert.equal(score(post({ selftext: 'MYVOO VTI2' })).eligible, false);
  assert.deepEqual(
    score(
      post({ selftext: 'Fed FOMC rebalancing factors tax loss treasuries' }),
    ).details.macroTerms,
    ['Fed', 'FOMC', 'rebalanc', 'factor', 'tax-loss', 'treasury'],
  );
});

void test('Bogleheads includes mutual funds without treating them as ETF symbols everywhere', () => {
  assert.equal(
    score(post({ selftext: 'VTSAX versus VFIAX and FSKAX' })).eligible,
    true,
  );
  assert.equal(
    score(
      post({ subreddit: 'SecurityAnalysis', selftext: 'VTSAX versus VFIAX' }),
    ).eligible,
    false,
  );
});

void test('raw exclusion rules and recurring threads are explicit, not score-based', () => {
  for (const overrides of [
    { selftext: '[removed]' },
    { selftext: ' [deleted] ' },
    { is_self: false },
    { is_self: null },
    { author: 'AutoModerator' },
    { author: 'automoderator' },
    { over_18: true },
    { title: 'Daily ETF Analysis' },
    { title: 'Weekly Portfolio Discussion' },
    { link_flair_text: 'Megathread' },
  ])
    assert.equal(score(post(overrides)).eligible, false);
});

void test('single-stock dollar tickers are blocked, dollars and whitelisted fund symbols are not', () => {
  assert.ok(
    score(post({ title: '$NVDA + VOO thesis' })).rejectionReasons.includes(
      'single_stock_title',
    ),
  );
  assert.ok(
    score(post({ title: '$BRK.B comparison' })).rejectionReasons.includes(
      'single_stock_title',
    ),
  );
  assert.equal(
    score(post({ title: 'A $1000 portfolio using $VOO' })).eligible,
    true,
  );
  assert.equal(score(post({ title: '$VTSAX allocation' })).eligible, true);
  assert.ok(
    score(post({ link_flair_text: 'Long Thesis' })).rejectionReasons.includes(
      'single_stock_flair',
    ),
  );
  assert.equal(
    score(
      post({
        link_flair_text: 'Company Analysis',
        selftext: 'Fed inflation duration',
      }),
    ).eligible,
    true,
  );
});

void test('approved flair rule rejects matching regexes, leaving missing/HFEA/US labels to body scoring', () => {
  for (const flair of [
    'Investing Questions',
    'Portfolio Review',
    'Advice requested',
    'Help',
    'Rate my allocation',
  ])
    assert.equal(score(post({ link_flair_text: flair })).eligible, false);
  for (const flair of [
    null,
    '',
    'US',
    'NON-US',
    'HFEA',
    'Articles & Resources',
  ]) {
    const result = score(post({ link_flair_text: flair }));
    assert.equal(result.eligible, true);
    assert.equal(result.flairDecision, 'unclassified');
  }
  for (const flair of [
    'Investment Theory',
    'BACKTESTING',
    'Research and Education',
    'Macro commentary',
  ])
    assert.equal(
      score(post({ link_flair_text: flair })).flairDecision,
      'accepted',
    );
  assert.equal(
    score(post({ link_flair_text: 'Analysis Question' })).flairDecision,
    'rejected',
  );
});

void test('body-length bands use characters, including unicode, without clipping text', () => {
  for (const [length, expected] of [
    [1499, 0],
    [1500, 20],
    [2999, 20],
    [3000, 30],
    [6000, 30],
    [6001, 35],
  ]) {
    const result = score(post({ selftext: 'VOO ' + '文'.repeat(length - 4) }));
    assert.equal(result.details.characters, length);
    assert.equal(result.points.length, expected);
  }
  assert.equal(score(post({ selftext: 'VOO 😀' })).details.characters, 5);
});

void test('each markdown structure contributes five once, up to fifteen', () => {
  const result = score(
    post({
      selftext:
        '# VOO analysis\n## More\n\n| ETF | Fee |\n| --- | ---: |\n| VOO | 0.03% |\n\n1. Allocation\n2. Risk',
    }),
  );
  assert.equal(result.points.structure, 15);
  assert.deepEqual(result.details.structure, {
    headings: true,
    table: true,
    numberedList: true,
  });
  assert.equal(
    score(post({ selftext: 'VOO\n```\n# Example heading\n1. Example\n```' }))
      .points.structure,
    0,
  );
});

void test('density counts percentages once, uses per-thousand denominator and caps at fifteen', () => {
  const head = 'VOO 10% 20 1,000 3.5% ';
  const result = score(
    post({ selftext: head + 'x'.repeat(1000 - head.length) }),
  );
  assert.equal(result.details.numberCount, 4);
  assert.equal(result.points.dataDensity, 4);
  const second = score(
    post({ selftext: head + 'x'.repeat(2000 - head.length) }),
  );
  assert.equal(second.points.dataDensity, 2);
  assert.equal(
    score(post({ selftext: 'VOO ' + '10% '.repeat(100) })).points.dataDensity,
    15,
  );
  assert.equal(
    score(post({ selftext: 'VOO https://example.org/2026/123456789' })).details
      .numberCount,
    0,
  );
});

void test('first-party source points use distinct validated domains, not repeated links or spoofed hosts', () => {
  const result = score(
    post({
      selftext:
        'VOO https://www.sec.gov/a https://sec.gov/b https://fred.stlouisfed.org/series/X https://bls.gov/a https://treasury.gov/a',
    }),
  );
  assert.equal(result.details.primarySources.length, 4);
  assert.equal(result.points.primarySources, 15);
  const spoofed = score(
    post({
      selftext:
        'VOO https://sec.gov.evil.test https://sec.gov@evil.test https://example.org/sec.gov',
    }),
  );
  assert.equal(spoofed.points.primarySources, 0);
  assert.equal(
    score(
      post({
        selftext:
          'VOO https://investor.vanguard.com/a https://papers.ssrn.com/a',
      }),
    ).points.primarySources,
    10,
  );
});

void test('topic points count distinct terms; self-reported flair and question/help penalties do not stack within groups', () => {
  const result = score(
    post({
      title: 'Should I get help and advice?',
      selftext: 'VOO VOO VTI Fed Fed inflation',
      author_flair_text: 'CFA, CPA, Quant analyst',
    }),
  );
  assert.equal(result.points.topic, 4);
  assert.equal(result.points.authorFlair, 5);
  assert.equal(result.points.questionPenalty, -15);
  assert.equal(result.points.helpPenalty, -20);
  assert.equal(result.score, 0);
  const good = score(
    post({
      selftext:
        '# Research\nVOO VTI VT VXUS QQQ SCHD JEPI BND AGG TLT\n1. Model\n| A | B |\n| --- | --- |\n' +
        '10% '.repeat(1500) +
        '\nhttps://sec.gov https://bls.gov https://nber.org',
      author_flair_text: 'PM',
    }),
  );
  assert.equal(good.score, 95);
  assert.equal(good.finalist, true);
});

void test('backfill makes exactly one request per requested community, keeps only requested fields and counts flairs first', async () => {
  const calls: URL[] = [];
  const data = await collectDeepBackfill(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      subreddit: ['Bogleheads', 'LETFs', 'SecurityAnalysis'][calls.length - 1],
      after: '30d',
      limit: 'auto',
      sort: 'desc',
    });
    const sample = post({
      subreddit: url.searchParams.get('subreddit')!,
      id: `abc${calls.length}`,
      selftext: '[removed]',
      link_flair_text: null,
    });
    return Response.json({
      data: [{ ...sample, irrelevant_private_field: 'never retained' }, sample],
    });
  }, base);
  assert.equal(calls.length, 3);
  assert.equal(data.requests, 3);
  assert.equal(data.posts.length, 3);
  assert.deepEqual(
    Object.keys(data.posts[0]).sort(),
    ['subreddit', ...DEEP_POST_FIELDS].sort(),
  );
  assert.deepEqual(data.communities[0].flairs, [
    { flair: '(无 flair)', count: 1 },
  ]);
});

void test('429 stops the entire backfill without retrying or silently changing parameters', async () => {
  let calls = 0;
  await assert.rejects(
    collectDeepBackfill(async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { 'X-RateLimit-Reset': '25' },
      });
    }),
    (error: unknown) =>
      error instanceof RedditRssError &&
      error.status === 429 &&
      error.retryAfter === '25',
  );
  assert.equal(calls, 1);
});
