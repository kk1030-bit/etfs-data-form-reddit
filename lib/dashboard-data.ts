import { env } from 'cloudflare:workers';

export type DashboardStory = {
  id: string;
  rank: number;
  previousRank: number | null;
  title: string;
  originalTitle: string;
  summary: string;
  highlights: string[];
  subreddit: string;
  author: string;
  publishedAt: string;
  heat: number;
  score: number;
  comments: number;
  velocity: number;
  topics: string[];
  permalink: string;
  analysisStatus: string;
  trend: number[];
};

export type DashboardReport = {
  label: string;
  headline: string;
  summary: string;
  coverage: string;
  generatedAt: string;
  themes: string[];
};

export type DashboardAuthor = {
  name: string;
  influence: number;
  observedPosts: number;
  hitRate: number;
  communities: number;
};

export type DashboardData = {
  mode: 'live' | 'demo';
  status: 'healthy' | 'partial' | 'delayed';
  updatedAt: string;
  logicalHour: string;
  candidateCount: number;
  activeTracked: number;
  rankSlots24h: number;
  uniquePosts24h: number;
  completedHours24h: number;
  stories: DashboardStory[];
  dailyReports: DashboardReport[];
  weeklyReports: DashboardReport[];
  authors: DashboardAuthor[];
  pipeline: Array<{ name: string; status: 'completed' | 'running' | 'waiting' | 'failed' }>;
};

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function valueString(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function demoData(): DashboardData {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const iso = now.toISOString();
  const stories: DashboardStory[] = [
    ['t3_demo1', 1, 3, '长期持有者正在重新讨论全球股票 ETF 的配置比例', 'Long-term holders revisit their global ETF allocation', '讨论集中在美国与全球市场的权重取舍，以及单一市场集中风险。', 'ETFs', 'indexing_mind', 92, 3821, 486, 3.42, ['全球配置', '集中风险'], [64, 68, 73, 82, 88, 92]],
    ['t3_demo2', 2, 7, '债券 ETF 在利率变化下重新进入资产配置视野', 'Bond ETFs are back in the allocation conversation', '高质量评论比较了久期、收益率与再投资风险，互动增速为本轮最高。', 'investing', 'quiet_compounder', 87, 2640, 319, 4.1, ['债券 ETF', '利率'], [42, 49, 55, 63, 76, 87]],
    ['t3_demo3', 3, 3, '小盘价值 ETF 是否仍值得长期配置？', 'Is a small-cap value tilt still worth it?', '支持与反对因子倾斜的观点势均力敌，成为今天争议度最高的话题。', 'Bogleheads', 'factor_friendly', 81, 1930, 274, 1.84, ['小盘价值', '因子投资'], [72, 74, 75, 79, 80, 81]],
    ['t3_demo4', 4, 3, '高股息 ETF：现金流需求与税务成本的现实权衡', 'Dividend ETFs: income needs versus tax drag', '重点从收益率转向总回报与税后现金流，热度仍高但增速开始放缓。', 'dividends', 'yield_context', 76, 1510, 198, 0.92, ['高股息', '税务'], [81, 83, 82, 80, 78, 76]],
    ['t3_demo5', 5, 6, '低成本并不等于低风险：主题 ETF 的隐性集中度', 'Low fee does not mean low risk for thematic ETFs', '多位高影响作者提醒关注持仓重叠、换手率与主题拥挤风险。', 'stocks', 'risk_first_', 72, 1230, 167, 1.46, ['主题 ETF', '风险'], [57, 58, 62, 65, 69, 72]],
  ].map((item) => ({
    id: item[0] as string,
    rank: item[1] as number,
    previousRank: item[2] as number,
    title: item[3] as string,
    originalTitle: item[4] as string,
    summary: item[5] as string,
    highlights: [item[5] as string, '本卡片为界面演示，接入 Reddit 凭证后会替换为实时结果。'],
    subreddit: item[6] as string,
    author: item[7] as string,
    publishedAt: new Date(now.getTime() - (item[1] as number) * 2_700_000).toISOString(),
    heat: item[8] as number,
    score: item[9] as number,
    comments: item[10] as number,
    velocity: item[11] as number,
    topics: item[12] as string[],
    permalink: 'https://www.reddit.com/',
    analysisStatus: 'demo',
    trend: item[13] as number[],
  }));

  return {
    mode: 'demo',
    status: 'healthy',
    updatedAt: iso,
    logicalHour: iso,
    candidateCount: 184,
    activeTracked: 37,
    rankSlots24h: 83,
    uniquePosts24h: 37,
    completedHours24h: 24,
    stories,
    dailyReports: [
      {
        label: new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10),
        headline: '配置分散与利率风险成为讨论主线',
        summary: '全球配置、债券久期与高股息税后回报是本日互动最密集的三个主题。',
        coverage: '24/24',
        generatedAt: iso,
        themes: ['全球配置', '债券久期', '税后回报'],
      },
      {
        label: new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10),
        headline: '低成本与持仓集中度引发新一轮讨论',
        summary: '主题 ETF 与大盘指数产品的持仓重叠成为热门作者反复提及的风险。',
        coverage: '23/24',
        generatedAt: iso,
        themes: ['费用率', '持仓重叠', '主题拥挤'],
      },
    ],
    weeklyReports: [
      {
        label: '最近 7 天',
        headline: 'ETF 热门话题周报｜资产配置重新成为焦点',
        summary: '一周讨论从产品费用转向组合层级的风险控制，全球分散、利率敏感度与因子倾斜持续上榜。',
        coverage: '7/7 天',
        generatedAt: iso,
        themes: ['资产配置', '全球分散', '利率敏感度', '因子投资'],
      },
    ],
    authors: [
      { name: 'indexing_mind', influence: 88, observedPosts: 18, hitRate: 0.42, communities: 3 },
      { name: 'quiet_compounder', influence: 82, observedPosts: 12, hitRate: 0.38, communities: 4 },
      { name: 'factor_friendly', influence: 79, observedPosts: 21, hitRate: 0.31, communities: 2 },
      { name: 'risk_first_', influence: 75, observedPosts: 9, hitRate: 0.33, communities: 3 },
    ],
    pipeline: [
      { name: '发现 Reddit 帖子', status: 'completed' },
      { name: '来源验证与去重', status: 'completed' },
      { name: '热度与作者排名', status: 'completed' },
      { name: '简中翻译与摘要', status: 'running' },
      { name: '发布小时榜单', status: 'waiting' },
    ],
  };
}

export async function getDashboardData(): Promise<DashboardData> {
  try {
    const latest = await env.DB
      .prepare(
        `SELECT logical_hour_utc, completed_at_utc, candidate_count, selected_count
         FROM hourly_runs WHERE status = 'completed'
         ORDER BY logical_hour_utc DESC LIMIT 1`,
      )
      .first<{
        logical_hour_utc: string;
        completed_at_utc: string;
        candidate_count: number;
        selected_count: number;
      }>();
    if (!latest) return demoData();
    const cutoff24h = new Date(Date.parse(latest.logical_hour_utc) - 24 * 60 * 60 * 1_000).toISOString();

    const storyResult = await env.DB
      .prepare(
        `SELECT hr.rank, hr.previous_rank, hr.heat_score,
                p.id, p.title_original, p.title_zh, p.summary_zh,
                p.highlights_json, p.topics_json, p.subreddit, p.author,
                p.created_at_utc, p.permalink, p.analysis_status,
                po.score, po.comments, po.velocity_score
         FROM hourly_rankings hr
         JOIN reddit_posts p ON p.id = hr.post_id
         JOIN post_observations po
           ON po.post_id = hr.post_id AND po.observed_hour_utc = hr.logical_hour_utc
         WHERE hr.logical_hour_utc = ?1
         ORDER BY hr.rank ASC`,
      )
      .bind(latest.logical_hour_utc)
      .all<Record<string, unknown>>();

    const trendResult = await env.DB
      .prepare(
        `SELECT po.post_id, po.heat_score
         FROM post_observations po
         WHERE po.observed_hour_utc >= ?1
         ORDER BY po.observed_hour_utc ASC`,
      )
      .bind(cutoff24h)
      .all<{ post_id: string; heat_score: number }>();
    const trends = new Map<string, number[]>();
    for (const row of trendResult.results ?? []) {
      const current = trends.get(row.post_id) ?? [];
      current.push(Number(row.heat_score));
      trends.set(row.post_id, current);
    }

    const stories: DashboardStory[] = (storyResult.results ?? []).map((row) => ({
      id: String(row.id),
      rank: Number(row.rank),
      previousRank: row.previous_rank === null ? null : Number(row.previous_rank),
      title: String(row.title_zh || row.title_original),
      originalTitle: String(row.title_original),
      summary: valueString(row.summary_zh, '翻译与重点整理处理中。'),
      highlights: safeJsonArray(row.highlights_json),
      subreddit: String(row.subreddit),
      author: valueString(row.author, '[deleted]'),
      publishedAt: String(row.created_at_utc),
      heat: Number(row.heat_score),
      score: Number(row.score),
      comments: Number(row.comments),
      velocity: Number(row.velocity_score),
      topics: safeJsonArray(row.topics_json),
      permalink: String(row.permalink),
      analysisStatus: String(row.analysis_status),
      trend: trends.get(String(row.id)) ?? [Number(row.heat_score)],
    }));

    const [counts, dailyRows, weeklyRows, authorRows] = await Promise.all([
      env.DB
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM tracking_episodes WHERE status = 'active') AS active_tracked,
             (SELECT COUNT(*) FROM hourly_rankings WHERE logical_hour_utc >= ?1) AS rank_slots,
             (SELECT COUNT(DISTINCT post_id) FROM hourly_rankings WHERE logical_hour_utc >= ?1) AS unique_posts,
             (SELECT COUNT(*) FROM hourly_runs WHERE status = 'completed' AND logical_hour_utc >= ?1) AS completed_hours`,
        )
        .bind(cutoff24h)
        .first<Record<string, number>>(),
      env.DB.prepare('SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 14').all<Record<string, unknown>>(),
      env.DB.prepare('SELECT * FROM weekly_reports ORDER BY week_start_date DESC LIMIT 8').all<Record<string, unknown>>(),
      env.DB.prepare('SELECT * FROM author_metrics ORDER BY influence_score DESC LIMIT 12').all<Record<string, unknown>>(),
    ]);

    const reports = (values: Record<string, unknown>[], weekly: boolean): DashboardReport[] =>
      values.map((row) => {
        const sections = typeof row.sections_json === 'string' ? JSON.parse(row.sections_json) : {};
        return {
          label: String(weekly ? row.week_start_date : row.report_date),
          headline: String(row.headline),
          summary: String(row.executive_summary),
          coverage: weekly
            ? `${Number(row.days_included)}/7 天`
            : `${Number(row.coverage_success)}/${Number(row.coverage_expected)}`,
          generatedAt: String(row.generated_at_utc),
          themes: Array.isArray(sections.themes) ? sections.themes : [],
        };
      });

    return {
      mode: 'live',
      status: Number(counts?.completed_hours ?? 0) >= 23 ? 'healthy' : 'partial',
      updatedAt: latest.completed_at_utc,
      logicalHour: latest.logical_hour_utc,
      candidateCount: latest.candidate_count,
      activeTracked: Number(counts?.active_tracked ?? 0),
      rankSlots24h: Number(counts?.rank_slots ?? 0),
      uniquePosts24h: Number(counts?.unique_posts ?? 0),
      completedHours24h: Number(counts?.completed_hours ?? 0),
      stories,
      dailyReports: reports(dailyRows.results ?? [], false),
      weeklyReports: reports(weeklyRows.results ?? [], true),
      authors: (authorRows.results ?? []).map((row) => ({
        name: String(row.author),
        influence: Math.round(Number(row.influence_score) * 100),
        observedPosts: Number(row.observed_posts),
        hitRate: Number(row.top_hit_rate),
        communities: Number(row.subreddit_count),
      })),
      pipeline: [
        { name: '发现 Reddit 帖子', status: 'completed' },
        { name: '来源验证与去重', status: 'completed' },
        { name: '热度与作者排名', status: 'completed' },
        { name: '简中翻译与摘要', status: 'completed' },
        { name: '发布小时榜单', status: 'completed' },
      ],
    };
  } catch {
    return demoData();
  }
}
