import { readFile, writeFile } from 'node:fs/promises';
import {
  scoreDeepAnalysis,
  DEEP_ETF_TICKERS,
  BOGLEHEADS_FUND_TICKERS,
} from '../lib/collector/deep-analysis.ts';
import type { DeepBackfill } from '../lib/collector/deep-analysis-source.ts';
import { DEEP_ANALYSIS_MIN_SCORE } from '../lib/collector/deep-analysis-policy.ts';
import {
  deepPublishedMs,
  compareDeepRecent,
} from '../lib/collector/deep-analysis-dates.ts';

const directory = new URL(
  process.argv.includes('--review')
    ? '../outputs/deep-analysis-ops-review/'
    : '../outputs/deep-analysis-backfill/',
  import.meta.url,
);
const data = JSON.parse(
  await readFile(new URL('collection.json', directory), 'utf8'),
) as DeepBackfill;
if (
  !Number.isFinite(Date.parse(data.fetchedAt)) ||
  Date.now() - Date.parse(data.fetchedAt) > 48 * 3600000
)
  throw new Error(
    'Local backfill input is older than the 48-hour retention window',
  );
const rejected: Record<string, number> = {};
// Approved by the user after inspecting the first flair-frequency audit.
const scored = data.posts.map((post) => ({
  post,
  result: scoreDeepAnalysis(post),
}));
for (const { result } of scored)
  for (const reason of result.rejectionReasons)
    rejected[reason] = (rejected[reason] ?? 0) + 1;
const eligible = scored
  .filter(({ result }) => result.eligible)
  .sort(
    (a, b) =>
      b.result.score - a.result.score ||
      Number(b.post.created_utc) - Number(a.post.created_utc) ||
      String(a.post.id).localeCompare(String(b.post.id)),
  );
const top20 = eligible.slice(0, 20).map(({ post, result }, index) => ({
  rank: index + 1,
  title: String(post.title),
  subreddit: post.subreddit,
  flair:
    typeof post.link_flair_text === 'string' && post.link_flair_text.trim()
      ? post.link_flair_text
      : '(无 flair)',
  permalink: `https://www.reddit.com/r/${encodeURIComponent(post.subreddit)}/comments/${String(post.id)}/`,
  ...result,
}));
const reviewedAt = Date.now();
const windowComparison = [30 * 24, 7 * 24, 72].map((hours) => {
  const rows = scored.filter(({ post }) => {
    const published = Number(post.created_utc) * 1000;
    return published <= reviewedAt && published >= reviewedAt - hours * 3600000;
  });
  return {
    hours,
    returned: rows.length,
    eligible: rows.filter(({ result }) => result.eligible).length,
    passed35: rows.filter(({ result }) => result.eligible && result.score >= 35)
      .length,
    passed20: rows.filter(({ result }) => result.finalist).length,
    passed55: rows.filter(({ result }) => result.eligible && result.score >= 55)
      .length,
  };
});
const recentFinalists = eligible
  .filter(
    ({ post, result }) =>
      result.finalist && deepPublishedMs(post.created_utc, reviewedAt) !== null,
  )
  .map(({ post, result }) => ({
    id: String(post.id),
    title: String(post.title),
    subreddit: post.subreddit,
    publishedAt: new Date(Number(post.created_utc) * 1000).toISOString(),
    score: result.score,
    permalink: `https://www.reddit.com/r/${post.subreddit}/comments/${String(post.id)}/`,
  }))
  .sort(compareDeepRecent);
const report = {
  fetchedAt: data.fetchedAt,
  scoredAt: new Date().toISOString(),
  requests: data.requests,
  policy: 'observe-only; reddit-depth-v2',
  scoreStage: 'base-only; no commenter/author bonus and no AI',
  minimumBaseScore: DEEP_ANALYSIS_MIN_SCORE,
  formula:
    'Length: 10/18/25 at 1000/2000/3500; structure: 4 each capped15; density: min(20,5*log2(1+density)); evidence:5 each capped15; topic:min(15,3*log2(1+distinct terms)); no flair or history bonus',
  whitelist: {
    etfs: DEEP_ETF_TICKERS.size,
    bogleheadsFunds: BOGLEHEADS_FUND_TICKERS.size,
  },
  collected: data.posts.length,
  eligible: eligible.length,
  finalists: eligible.filter(({ result }) => result.finalist).length,
  rejectionCountsNonExclusive: rejected,
  coverage: data.communities,
  top20,
  recentFinalists,
  windowComparison,
};
await writeFile(
  new URL('scoring-report.json', directory),
  JSON.stringify(report, null, 2),
  'utf8',
);
const cell = (value: string | number) =>
  String(value)
    .replace(/[\r\n]/g, ' ')
    .replace(/[|<>[\]`]/g, ' ');
const markdown = [
  '# 深度分析：新版评分校准报告（非 AI 结果）',
  '',
  `采集于 ${data.fetchedAt}；仅 ${data.requests} 个回填请求。`,
  `取得 ${report.collected} 篇，通过自发文／长度／主题资格 ${report.eligible} 篇，达到 ${DEEP_ANALYSIS_MIN_SCORE} 分地板共 ${report.finalists} 篇。`,
  `下表为初评分前 20 名。生产任务对初评前 10 查询互动后选前 5 送 AI；此处无互动补分、无 AI，不代表已通过审查。`,
  'limit=auto 不保证穷尽过去 30 天；正文仅用于本地评分，未进入网站、D1 或 AI。',
  '',
  '## 同一回填样本：视窗与门槛对照（未去重、未运行 AI）',
  '',
  '| 视窗 | 返回篇数 | 通过资格 | ≥20 | ≥35（旧门槛对照） | ≥55（旧门槛对照） |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...windowComparison.map(
    (w) =>
      `| ${w.hours} 小时 | ${w.returned} | ${w.eligible} | ${w.passed20} | ${w.passed35} | ${w.passed55} |`,
  ),
  '',
  `## 新增日期规则复核（截至 ${new Date(reviewedAt).toISOString()}）`,
  '',
  `发布在最近 7 天且初评分 ≥${DEEP_ANALYSIS_MIN_SCORE}：${recentFinalists.length} 篇。按北京发布日期分组、日内按分数，不以抓取时间代替。仍未运行 AI。`,
  ...recentFinalists.map(
    (p) =>
      `- ${p.publishedAt} · ${p.score} 分 · [${cell(p.title)}](${p.permalink})`,
  ),
  '',
  '## 原始 30 天回填：按初评分的前 20 名（包含旧文，仅供审阅）',
  '',
  `| 排名 | 初评分 | 社群 | 标题 | flair | ≥${DEEP_ANALYSIS_MIN_SCORE} |`,
  '| --- | ---: | --- | --- | --- | --- |',
  ...top20.map(
    (post) =>
      `| ${post.rank} | ${post.score} | ${post.subreddit} | [${cell(post.title)}](${post.permalink}) | ${cell(post.flair)} | ${post.finalist ? '是' : '否'} |`,
  ),
  '',
  '## flair 频率（筛选前）',
  '',
  ...data.communities.flatMap((community) => [
    `### r/${community.subreddit}`,
    '',
    `实际返回 ${community.returned} 篇；最早 ${community.oldest}，最新 ${community.newest}。`,
    '',
    '| flair | 数量 |',
    '| --- | ---: |',
    ...community.flairs.map(
      (item) => `| ${cell(item.flair)} | ${item.count} |`,
    ),
    '',
  ]),
].join('\n');
await writeFile(new URL('scoring-report.md', directory), markdown, 'utf8');
console.log(markdown);
