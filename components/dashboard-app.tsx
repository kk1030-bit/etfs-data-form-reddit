'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  Activity,
  BookOpenText,
  CheckCircle2,
  CircleDot,
  Clock3,
  ExternalLink,
  Flame,
  Gauge,
  History,
  Menu,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LeadTopics } from '@/components/lead-topics';
import { DeepAnalysisView } from '@/components/deep-analysis-view';
import { defaultDeepView } from '@/lib/collector/deep-analysis-dates';
import { commentMetricLabel, commentGrowthLabel } from '@/lib/comment-metric';
import {
  hourlyCollectionHistory,
  hourlyCollectionLabel,
} from '@/lib/hourly-collection-history';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  DashboardData,
  DashboardReport,
  DashboardStory,
} from '@/lib/dashboard-data';

type ViewId =
  | 'deep'
  | 'top'
  | 'tracking'
  | 'daily'
  | 'weekly'
  | 'authors'
  | 'status';

const navigation: Array<{ id: ViewId; label: string; icon: typeof Flame }> = [
  { id: 'deep', label: '深度分析', icon: BookOpenText },
  { id: 'top', label: '最新榜单 Top 5', icon: Flame },
  { id: 'tracking', label: '24 小时追踪', icon: Activity },
  { id: 'daily', label: '历史日报', icon: History },
  { id: 'weekly', label: '每周报告', icon: BookOpenText },
  { id: 'authors', label: '来源与作者', icon: Users },
  { id: 'status', label: '运行状态', icon: Gauge },
];

function formatBeijing(
  iso: string | null | undefined,
  withDate = false,
): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: withDate ? '2-digit' : undefined,
    day: withDate ? '2-digit' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function TrendBars({
  values,
  compact = false,
}: {
  values: number[];
  compact?: boolean;
}) {
  if (values.length < 2) {
    return (
      <p className="py-3 text-xs text-muted-foreground">
        {values.length ? '仅 1 次观察，待累积趋势' : '暂无趋势记录'}
      </p>
    );
  }
  const maximum = Math.max(...values, 1);
  return (
    <div
      className={`flex items-end gap-1 ${compact ? 'h-7 w-20' : 'h-16 w-full'}`}
      aria-label="榜单趋势"
    >
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className="min-w-1 flex-1 rounded-t-sm bg-primary/25 last:bg-primary"
          style={{ height: `${Math.max(12, (value / maximum) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function RedditPostLink({
  story,
  label = 'Reddit 原帖',
  className = '',
}: {
  story: DashboardStory;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={story.permalink}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label}：${story.originalTitle}`}
      className={className}
    >
      {label} <ExternalLink className="size-3.5 shrink-0" />
    </a>
  );
}

function StoryDetail({
  story,
  onClose,
}: {
  story: DashboardStory;
  onClose: () => void;
}) {
  return (
    <Card className="editorial-detail border-0 bg-card text-foreground ring-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-white/10">
            <Sparkles className="size-4 text-[#ff8a66]" />
          </div>
          <Button
            onClick={onClose}
            variant="ghost"
            size="icon-sm"
            aria-label="关闭详情"
            className="text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X />
          </Button>
        </div>
        <CardTitle className="mt-2 text-base font-semibold text-white">
          三句话看懂
        </CardTitle>
        <CardDescription className="text-white/55">
          标题与短节录的机器翻译，仅供快速阅读
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm font-medium leading-6">{story.title}</p>
        <p className="text-xs leading-5 text-white/60" lang="en">
          {story.originalTitle}
        </p>
        <ol className="space-y-2 text-xs leading-5 text-white/72">
          {(story.highlights.length ? story.highlights : [story.summary]).map(
            (highlight, index) => (
              <li key={highlight} className="flex gap-2">
                <span className="text-[#ff8a66]">0{index + 1}</span>
                <span>{highlight}</span>
              </li>
            ),
          )}
        </ol>
        {story.translation ? (
          <details className="rounded-xl border border-white/15 p-3 text-sm leading-6">
            <summary className="cursor-pointer font-medium">
              阅读短节录翻译
            </summary>
            <p className="mt-3 whitespace-pre-wrap text-white/80">
              {story.translation}
            </p>
          </details>
        ) : null}
        {story.indexedAt ? (
          <p className="text-xs text-white/60">
            索引快照：{formatBeijing(story.indexedAt, true)} · Arctic Shift
            <br />
            {commentMetricLabel(story)}。索引可能延迟或补收，不代表 Reddit
            实时总留言或浏览量。
            <br />
            {commentGrowthLabel(story)}
          </p>
        ) : null}
        <div className="rounded-xl bg-white/7 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-white/50">
            <span>
              {story.metricsAvailable ? '24 小时热度' : '24 小时入榜轨迹'}
            </span>
            <span>{Math.round(story.heat)}/100</span>
          </div>
          <TrendBars values={story.trend} />
        </div>
        <RedditPostLink
          story={story}
          label="打开 Reddit 原帖"
          className="flex min-h-10 items-center justify-between rounded-xl border border-white/10 px-3 text-xs font-medium hover:bg-white/5"
        />
      </CardContent>
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border px-5 py-16 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function ReportsView({
  reports,
  weekly,
}: {
  reports: DashboardReport[];
  weekly?: boolean;
}) {
  if (!reports.length)
    return (
      <Empty>
        尚未生成{weekly ? '周报' : '日报'}；排程完成后会自动归档在这里。
      </Empty>
    );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {reports.map((report, index) => (
        <Card
          key={`${report.label}-${index}`}
          className="border-0 ring-1 ring-border"
        >
          <CardHeader>
            <div className="mb-2 flex items-center justify-between">
              <Badge
                variant={
                  report.coverage.startsWith('24') ||
                  report.coverage.startsWith('7')
                    ? 'secondary'
                    : 'outline'
                }
              >
                {report.coverage}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {report.label}
              </span>
            </div>
            <CardTitle className="text-lg font-semibold">
              {report.headline}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-6 text-muted-foreground">
              {report.summary}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {report.themes.map((theme) => (
                <Badge key={theme} variant="outline">
                  {theme}
                </Badge>
              ))}
            </div>
            {weekly && report.deepAnalysis?.length ? (
              <div className="mt-6 space-y-4 border-t border-border pt-5">
                <h3 className="text-base font-semibold">
                  本周深度分析 · 评分最高三篇
                </h3>
                {report.deepAnalysis.map((article, i) => (
                  <div key={i} className="space-y-2 text-sm leading-6">
                    <p>{article.thesis}</p>
                    {article.keyData.map((line, n) => (
                      <p key={n} className="text-muted-foreground">
                        {line}
                      </p>
                    ))}
                    <p className="text-muted-foreground">
                      反方观点：{article.counterpoints}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
            <p className="mt-5 text-xs text-muted-foreground">
              {report.analysisStatus === 'aggregate'
                ? '统计汇总版：AI 未生成扩展摘要，原始统计已正常归档。 '
                : ''}
              生成于 {formatBeijing(report.generatedAt, true)}（北京时间）
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function DashboardApp({ initialData }: { initialData: DashboardData }) {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<ViewId>(() =>
    defaultDeepView(
      initialData.deepAnalysis?.articles,
      Date.parse(initialData.checkedAt),
    ),
  );
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<DashboardStory | null>(null);
  const [isPending, startTransition] = useTransition();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const requestActive = useRef(false);
  const isRssPreview = data.mode === 'rss-preview';
  const isIndexed = data.mode === 'arctic-shift';
  const sourceLabel = isIndexed
    ? 'Arctic Shift · Reddit 索引'
    : isRssPreview
      ? 'Reddit RSS'
      : 'Reddit API';
  const filteredStories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data.stories;
    return data.stories.filter((story) =>
      [
        story.title,
        story.originalTitle,
        story.subreddit,
        story.author,
        ...story.topics,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [data.stories, query]);
  const filteredTrackedStories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data.trackedStories;
    return data.trackedStories.filter((story) =>
      [
        story.title,
        story.originalTitle,
        story.subreddit,
        story.author,
        ...story.topics,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [data.trackedStories, query]);

  const readLatest = useCallback(async () => {
    if (requestActive.current) return;
    requestActive.current = true;
    try {
      const response = await fetch('/api/dashboard', {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      if (
        !response.ok ||
        !response.headers.get('content-type')?.includes('application/json')
      )
        throw new Error('refresh');
      const next = (await response.json()) as DashboardData;
      if (!Array.isArray(next.stories) || !next.checkedAt)
        throw new Error('format');
      setData(next);
      setSelected((current) =>
        current
          ? ([...next.stories, ...next.trackedStories].find(
              (story) => story.id === current.id,
            ) ?? null)
          : null,
      );
      setRefreshError(null);
    } catch {
      setRefreshError(
        '暂时无法更新页面，已保留上次内容；将在下次自动刷新时重试。',
      );
    } finally {
      requestActive.current = false;
    }
  }, []);
  const refresh = () => startTransition(readLatest);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void readLatest();
    };
    const timer = window.setInterval(onVisible, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [readLatest]);

  const activeLabel = navigation.find((item) => item.id === view)?.label ?? '';
  const scheduler = data.scheduler;
  const hourlyHistory = hourlyCollectionHistory(
    data.recentRuns,
    Date.parse(data.checkedAt),
    Boolean(data.statusError),
  );
  const statusLabel = scheduler?.isOverdue
    ? '小时采集漏跑／待完成'
    : scheduler?.checkUnavailable || scheduler?.checkStale
      ? '排程检查待确认'
      : scheduler?.configured === false
        ? '补触发需配置专用 token'
        : scheduler && !scheduler.currentHourCompleted
          ? '本小时采集待完成'
          : data.cooldownUntil
            ? 'Reddit 限流，冷却中'
            : data.status === 'healthy'
              ? '采集器运行正常'
              : data.status === 'delayed'
                ? '采集延迟，沿用上次成功结果'
                : '部分环节或小时数据待完成';
  const navigate = (next: ViewId) => {
    setView(next);
    setMenuOpen(false);
    setSelected(null);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const compactLeadEdition =
    view === 'top' &&
    !searchOpen &&
    !query &&
    data.stories.length > 0 &&
    !refreshError &&
    !data.cooldownUntil &&
    !data.latestAttempt?.error &&
    !data.statusError &&
    !scheduler?.needsAttention &&
    data.status !== 'delayed' &&
    !(isIndexed && data.sourceDetails?.warnings?.length);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [view]);

  return (
    <main className="editorial-app">
      <a className="editorial-skip" href="#main-content">
        跳到内容
      </a>
      <div className="editorial-frame">
        <section className="min-w-0">
          <header className="editorial-header">
            <button
              className="editorial-brand"
              onClick={() => navigate('top')}
              aria-label="etfs热门话题，返回最新榜单"
            >
              <Radio aria-hidden="true" strokeWidth={1.6} />
              <span>etfs热门话题</span>
            </button>
            <nav
              className={`editorial-nav ${menuOpen ? 'is-open' : ''}`}
              id="main-navigation"
              aria-label="主要导航"
            >
              {navigation.map((item) => (
                <button
                  key={item.id}
                  onClick={() => navigate(item.id)}
                  aria-current={view === item.id ? 'page' : undefined}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="editorial-tools">
              <button
                className="editorial-icon"
                aria-label={searchOpen ? '关闭搜索' : '搜索话题'}
                aria-expanded={searchOpen}
                aria-controls="topic-search"
                onClick={() => {
                  setSearchOpen(!searchOpen);
                  if (!searchOpen)
                    window.requestAnimationFrame(() =>
                      searchInput.current?.focus(),
                    );
                }}
              >
                <Search aria-hidden="true" />
              </button>
              <button
                className="editorial-icon"
                aria-label="刷新状态"
                title="只刷新现有记录，不触发采集"
                onClick={refresh}
                disabled={isPending}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={isPending ? 'animate-spin' : ''}
                />
              </button>
              <button
                className="editorial-icon editorial-menu"
                aria-label={menuOpen ? '关闭导航' : '打开导航'}
                aria-expanded={menuOpen}
                aria-controls="main-navigation"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                {menuOpen ? (
                  <X aria-hidden="true" />
                ) : (
                  <Menu aria-hidden="true" />
                )}
              </button>
            </div>
          </header>
          <div
            className={`editorial-content ${compactLeadEdition ? 'editorial-content-top' : ''}`}
            id="main-content"
          >
            <div>
              <div className="editorial-edition">
                <p>
                  <CircleDot aria-hidden="true" />
                  {view === 'top' ? '最近成功榜单 Top 5' : activeLabel}
                  <span>·</span>
                  {formatBeijing(
                    view === 'deep'
                      ? data.deepAnalysis?.updatedAt
                      : data.updatedAt,
                    true,
                  )}
                  （北京时间）
                  {data.mode === 'demo' ? ' · 演示数据' : ''}
                </p>
                <span className="editorial-edition-source">{sourceLabel}</span>
              </div>
              <div
                id="topic-search"
                className="editorial-search"
                hidden={!searchOpen}
              >
                <label htmlFor="topic-search-input">搜索话题、社区或作者</label>
                <div className="editorial-search-field">
                  <Input
                    id="topic-search-input"
                    ref={searchInput}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="输入关键词"
                  />
                  {query && (
                    <button onClick={() => setQuery('')}>清除搜索</button>
                  )}
                </div>
              </div>
              {query && !searchOpen ? (
                <button
                  className="editorial-query"
                  onClick={() => {
                    setQuery('');
                  }}
                >
                  搜索：{query} · 清除
                </button>
              ) : null}
              {view !== 'top' ? (
                <div className="editorial-section-heading mb-7 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
                  <div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge className="bg-[#ff5a36]/12 text-[#d63f1f]">
                        仅采集 Reddit
                      </Badge>
                      <Badge variant="outline">
                        {data.mode === 'demo'
                          ? '演示数据'
                          : isIndexed
                            ? '公开索引 · 免费采集'
                            : isRssPreview
                              ? 'RSS 预览・私有测试'
                              : 'OAuth 数据'}
                      </Badge>
                    </div>
                    <h1 className="font-heading text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">
                      {activeLabel}
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                      {view === 'deep'
                        ? '聚焦 ETF、宏观与资产配置的近期长文。先审查内容，再按发布时间由新到旧显示；同一时间按分数排序。'
                        : view === 'tracking'
                          ? isIndexed
                            ? '跟踪每篇入榜帖最多 24 小时；小时榜单可以重复出现同一话题，最多 120 个席位，不等于 120 篇不同文章。'
                            : isRssPreview
                              ? '同一帖子跨小时去重，记录最多 24 小时的入榜轨迹；未出现在本轮 RSS 不代表已删除。'
                              : '同一帖子跨小时去重，保留最多 24 个小时的热度轨迹。'
                          : view === 'authors'
                            ? isRssPreview || isIndexed
                              ? '只统计作者在本采集器中的入榜活跃度，不能据此认定为 KOL。'
                              : '热门作者是站内互动影响力估算，并非 Reddit 官方认证身份。'
                            : view === 'status'
                              ? '查看小时资料是否按时完成、排程检查结果与最近一轮实际采集步骤。'
                              : '所有统计按北京时间自然日归档，原始时间统一以 UTC 保存。'}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:gap-3">
                    {(view === 'deep'
                      ? [
                          [
                            '近期文章',
                            String(data.deepAnalysis?.articles.length ?? 0),
                          ],
                          ['发布时间', '最近 7 天'],
                          ['每日审查', '北京 08:30'],
                        ]
                      : [
                          [
                            '上次成功候选',
                            data.updatedAt ? String(data.candidateCount) : '—',
                          ],
                          ['24h 席位', `${data.rankSlots24h} / 120`],
                          ['近 24h 成功', `${data.completedHours24h} / 24`],
                        ]
                    ).map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-xl border border-border bg-card px-3 py-2.5 sm:min-w-28"
                      >
                        <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                          {label}
                        </p>
                        <p className="mt-1 text-sm font-semibold tabular-nums">
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {view !== 'top' ? (
                <div className="mb-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{sourceLabel} · 每分钟自动刷新页面</span>
                  <span>
                    页面更新于 {formatBeijing(data.checkedAt, true)}（北京）
                  </span>
                </div>
              ) : null}
              {refreshError ? (
                <p
                  className="mb-4 rounded-lg border border-amber-500/25 p-3 text-sm"
                  aria-live="polite"
                >
                  {refreshError}
                </p>
              ) : null}
              {isIndexed &&
              (view === 'status' ||
                (view === 'top' &&
                  !data.stories.length &&
                  !data.titleFallback?.items.length)) ? (
                <section
                  className="mb-5 rounded-xl border border-border bg-card p-4 text-sm"
                  aria-label="索引来源说明"
                >
                  <p className="font-medium">Reddit ETF 讨论观察</p>
                  <p className="mt-1 leading-6 text-muted-foreground">
                    每小时检索六个社区最近 24
                    小时的帖子。按逐帖已索引留言增速、总数、ETF
                    相关性和新鲜度排名；新手类 flair
                    降权，候选足够时前五至少三篇含具体 ETF 代号。
                    指数不是实际流量，也不是官方 KOL 排名；首次计数先建立基准。
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      最近帖文：
                      {formatBeijing(data.sourceDetails?.newestPostAt, true)}
                    </span>
                    <span>
                      {data.sourceDetails?.commentMetric === 'indexed-total'
                        ? `逐帖计数：${data.sourceDetails.aggregateSucceeded ?? 0} / ${data.sourceDetails.aggregateRequested ?? 0} 篇`
                        : `旧版讨论样本：${data.sourceDetails?.commentSampleSize ?? 0} 条`}
                    </span>
                    <span>
                      有效社区：{data.sourceDetails?.communities?.length ?? 0} /
                      6
                    </span>
                  </div>
                </section>
              ) : null}
              {view !== 'deep' &&
              isIndexed &&
              Boolean(data.sourceDetails?.warnings?.length) ? (
                <details className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-xs leading-6">
                  <summary className="cursor-pointer font-medium">
                    本轮来源覆盖说明（{data.sourceDetails?.warnings.length} 项）
                  </summary>
                  <ul className="mt-2 list-disc pl-5">
                    {data.sourceDetails?.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {view !== 'deep' &&
              (data.cooldownUntil ||
                data.latestAttempt?.error ||
                data.statusError ||
                scheduler?.needsAttention ||
                data.status === 'delayed') ? (
                <section
                  aria-label="采集状态提示"
                  aria-live="polite"
                  className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm"
                >
                  <p className="font-semibold">
                    {data.statusError
                      ? '运行状态暂不可用'
                      : scheduler?.isOverdue
                        ? '小时采集漏跑／待完成'
                        : scheduler?.configured === false
                          ? '补触发需要配置专用 token'
                          : scheduler?.checkUnavailable || scheduler?.checkStale
                            ? 'Cloudflare 排程检查待确认'
                            : scheduler?.needsAttention
                              ? '排程检查或补触发待处理'
                              : data.cooldownUntil
                                ? `${sourceLabel} 限流，已进入冷却`
                                : data.latestAttempt?.error
                                  ? '最近一轮未取得完整新数据'
                                  : '当前展示较早的成功数据'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {data.statusError ??
                      scheduler?.message ??
                      data.latestAttempt?.error ??
                      '没有把旧资料当成本小时的新采集结果。'}
                    {data.cooldownUntil
                      ? ` 冷却期间暂停来源请求；预计 ${formatBeijing(data.nextRetryAt, true)} 的${scheduler ? ' GitHub :10 ' : '整点'}排程恢复尝试（北京时间）。`
                      : ''}
                  </p>
                  {scheduler?.needsAttention ? (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {scheduler.checkMessage}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    最后成功采集：{formatBeijing(data.updatedAt, true)}；
                    {scheduler ? '最新 Cloudflare 检查' : '最近实际采集开始'}：
                    {formatBeijing(
                      scheduler
                        ? scheduler.latestCheck?.checkedAt
                        : data.latestAttempt?.startedAt,
                      true,
                    )}
                    。 刷新状态只读取现有记录，不会触发采集。
                  </p>
                </section>
              ) : null}

              {view === 'deep' ? (
                <DeepAnalysisView
                  data={data.deepAnalysis}
                  query={query}
                  nowMs={Date.parse(data.checkedAt)}
                />
              ) : null}
              {view === 'top' ? (
                data.titleFallback?.items.length &&
                (data.cooldownUntil ||
                  data.status === 'delayed' ||
                  !data.stories.length) ? (
                  <section
                    className="mb-6 space-y-3"
                    aria-labelledby="fallback-heading"
                  >
                    <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2
                          id="fallback-heading"
                          className="text-base font-semibold"
                        >
                          Reddit 标题索引 · 免费备援
                        </h2>
                        <Badge variant="outline">非实时热门排行</Badge>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        主来源暂不可用时，从 Google 公开新闻索引筛选 Reddit ETF
                        标题，按索引标示时间展示最多五条，过滤信息过少的标题。GitHub
                        免费排程每小时 :10
                        读取，可能延迟。仅有标题，未取得作者、正文和互动数；以下中文是标题概述，不计入正式热门榜、追踪或历史报告。
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        索引更新于{' '}
                        {formatBeijing(data.titleFallback.checkedAt, true)}
                        （北京） · 候选 {data.titleFallback.sourceCount} 条 ·
                        中文完成{' '}
                        {
                          data.titleFallback.items.filter(
                            (item) => item.analysisStatus === 'completed',
                          ).length
                        }{' '}
                        / {data.titleFallback.items.length}
                      </p>
                    </div>
                    {data.titleFallback.items
                      .filter((item) =>
                        `${item.title} ${item.titleZh}`
                          .toLowerCase()
                          .includes(query.toLowerCase().trim()),
                      )
                      .map((item) => (
                        <Card
                          key={item.id}
                          className="border-0 ring-1 ring-border"
                        >
                          <CardContent className="space-y-3 py-5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>Reddit · Google 标题索引</span>
                              <span>
                                索引标示时间{' '}
                                {formatBeijing(item.indexedPublishedAt, true)}
                              </span>
                            </div>
                            <h3 className="text-lg font-semibold leading-7">
                              {item.titleZh || item.title}
                            </h3>
                            {item.titleZh ? (
                              <p className="text-sm leading-6 text-muted-foreground">
                                原标题：{item.title}
                              </p>
                            ) : null}
                            <p className="text-base leading-7">
                              {item.summaryZh ||
                                '中文暂未生成；此处保留索引原标题，不补写正文。'}
                            </p>
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-primary hover:underline"
                            >
                              打开 Google 来源索引{' '}
                              <ExternalLink className="size-3.5" />
                            </a>
                            <p className="text-xs text-muted-foreground">
                              索引链接经 Google 跳转；尚未核实直接 Reddit
                              原帖地址，请以打开后的原帖为准。
                            </p>
                          </CardContent>
                        </Card>
                      ))}
                  </section>
                ) : null
              ) : null}

              {view === 'top' &&
              (data.stories.length > 0 || !data.titleFallback?.items.length) ? (
                <LeadTopics
                  data={data}
                  stories={filteredStories}
                  onSelect={setSelected}
                  onDaily={() => navigate('daily')}
                />
              ) : null}

              {view === 'tracking' ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filteredTrackedStories.length ? (
                    filteredTrackedStories.map((story) => (
                      <Card
                        key={story.id}
                        className="border-0 ring-1 ring-border"
                      >
                        <CardHeader>
                          <div className="flex items-center justify-between">
                            <Badge variant="secondary">
                              最高 #{story.rank}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              24h 追踪
                            </span>
                          </div>
                          <CardTitle className="mt-2 line-clamp-2 text-base font-semibold">
                            {story.title}
                          </CardTitle>
                          <CardDescription>
                            r/{story.subreddit} · u/{story.author}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <TrendBars values={story.trend} />
                          {story.sourceProvider === 'arctic-shift' ? (
                            <p className="mt-3 text-xs leading-5 text-muted-foreground">
                              {commentMetricLabel(story)}
                              <br />
                              {commentGrowthLabel(story)}
                            </p>
                          ) : null}
                          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                            <div>
                              <p className="font-mono text-base font-semibold">
                                {Math.round(story.heat)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {story.metricsAvailable
                                  ? '峰值热度'
                                  : '峰值指数'}
                              </p>
                            </div>
                            {story.metricsAvailable ? (
                              <>
                                <div>
                                  <p className="font-mono text-base font-semibold">
                                    {story.comments}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    最新评论
                                  </p>
                                </div>
                                <div>
                                  <p className="font-mono text-base font-semibold">
                                    {story.velocity.toFixed(1)}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    最新速度
                                  </p>
                                </div>
                              </>
                            ) : (
                              <>
                                <div>
                                  <p className="font-mono text-base font-semibold">
                                    {story.trend.length}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    入榜观察
                                  </p>
                                </div>
                                <div>
                                  <p className="font-mono text-base font-semibold">
                                    {story.sourceProvider === 'arctic-shift'
                                      ? '索引'
                                      : 'RSS'}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    指标来源
                                  </p>
                                </div>
                              </>
                            )}
                          </div>
                        </CardContent>
                        <CardFooter className="justify-end bg-transparent px-4 py-2">
                          <RedditPostLink
                            story={story}
                            className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary hover:underline"
                          />
                        </CardFooter>
                      </Card>
                    ))
                  ) : (
                    <Empty>没有符合当前搜索条件的追踪帖子。</Empty>
                  )}
                </div>
              ) : null}
              {view === 'daily' ? (
                <ReportsView reports={data.dailyReports} />
              ) : null}
              {view === 'weekly' ? (
                <ReportsView reports={data.weeklyReports} weekly />
              ) : null}
              {view === 'authors' ? (
                <Card className="border-0 ring-1 ring-border">
                  <CardHeader>
                    <CardTitle className="text-base font-semibold">
                      {isRssPreview || isIndexed
                        ? '活跃作者观察'
                        : '热门作者观察'}
                    </CardTitle>
                    <CardDescription>
                      {isIndexed
                        ? '依据已索引 ETF 话题与本采集器入榜记录观察作者；不代表官方影响力或认证 KOL。'
                        : isRssPreview
                          ? '依据最近 48 小时 RSS 候选与入榜记录计算，只代表本采集器的观察结果。'
                          : '依据最近 48 小时全部候选 Reddit ETF 帖子估算，不只统计入榜帖。'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>作者</TableHead>
                          <TableHead>
                            {isRssPreview || isIndexed
                              ? '观察活跃度'
                              : '影响力'}
                          </TableHead>
                          <TableHead>观察帖子</TableHead>
                          <TableHead>
                            {isRssPreview || isIndexed
                              ? '入榜率'
                              : '热门命中率'}
                          </TableHead>
                          <TableHead>社区数</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.authors.map((author) => (
                          <TableRow key={author.name}>
                            <TableCell className="font-medium">
                              u/{author.name}
                            </TableCell>
                            <TableCell>
                              <span className="font-mono">
                                {author.influence}
                              </span>
                              /100
                            </TableCell>
                            <TableCell>{author.observedPosts}</TableCell>
                            <TableCell>
                              {Math.round(author.hitRate * 100)}%
                            </TableCell>
                            <TableCell>{author.communities}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <div className="mt-5 rounded-xl bg-muted/60 p-4 text-xs leading-5 text-muted-foreground">
                      <strong className="text-foreground">
                        内容平台仅限 Reddit；传输来源：{sourceLabel}。
                      </strong>{' '}
                      {isIndexed
                        ? '索引中的点赞及留言总数可能延迟，本网站不把它们作为实时流量。'
                        : isRssPreview
                          ? 'RSS 没有 karma、浏览量或官方 KOL 身份；系统不会据此建立跨平台身份画像。'
                          : '系统不会把热门作者标成“认证 KOL”，也不会建立跨平台身份画像。'}
                    </div>
                  </CardContent>
                </Card>
              ) : null}
              {view === 'status' ? (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <Card className="border-0 ring-1 ring-border">
                    <CardHeader>
                      <CardTitle className="text-base font-semibold">
                        最近一轮采集流程
                      </CardTitle>
                      <CardDescription>
                        采集所属小时：
                        {formatBeijing(data.latestAttempt?.logicalHour, true)}
                        ；开始于{' '}
                        {formatBeijing(data.latestAttempt?.startedAt, true)}
                        （北京时间）
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      <dl className="mb-4 grid gap-3 rounded-xl bg-muted/50 p-4 text-xs sm:grid-cols-2">
                        <div>
                          <dt className="text-muted-foreground">
                            最后成功采集完成于
                          </dt>
                          <dd className="mt-1 font-medium">
                            {formatBeijing(data.updatedAt, true)}
                            <span className="mt-1 block text-muted-foreground">
                              数据所属小时：
                              {formatBeijing(data.logicalHour, true)}
                            </span>
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            最近实际请求来源
                          </dt>
                          <dd className="mt-1 font-medium">
                            {isRssPreview || isIndexed
                              ? formatBeijing(data.sourceLastAttemptAt, true)
                              : '请参阅本次采集状态'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            冷却截止（北京时间）
                          </dt>
                          <dd className="mt-1 font-medium">
                            {data.cooldownUntil
                              ? formatBeijing(data.cooldownUntil, true)
                              : '无冷却限制'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            状态与近 24h 统计读取于
                          </dt>
                          <dd className="mt-1 font-medium">
                            {formatBeijing(data.checkedAt, true)}
                          </dd>
                        </div>
                      </dl>
                      {data.latestAttempt?.error ? (
                        <p className="py-2 text-xs leading-5 text-muted-foreground">
                          {data.latestAttempt.error}
                        </p>
                      ) : null}
                      {data.latestAttempt?.stage === 'preparing' ||
                      data.latestAttempt?.stage === 'unknown' ? (
                        <p className="py-2 text-xs text-muted-foreground">
                          {data.latestAttempt.status === 'running'
                            ? '正在准备采集和执行保留清理。'
                            : '旧记录或准备阶段未提供具体步骤；以下不会推测具体故障。'}
                        </p>
                      ) : null}
                      {data.pipeline.map((step, index) => (
                        <div
                          key={step.name}
                          className="flex min-h-14 items-center gap-4 border-b border-border/60 last:border-0"
                        >
                          <span
                            className={`grid size-7 place-items-center rounded-full ${step.status === 'completed' ? 'bg-emerald-500/10 text-emerald-600' : step.status === 'running' ? 'bg-primary/10 text-primary' : step.status === 'failed' ? 'bg-destructive/10 text-destructive' : step.status === 'cooldown' ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground'}`}
                          >
                            {step.status === 'completed' ? (
                              <CheckCircle2 className="size-4" />
                            ) : (
                              <span className="text-xs">{index + 1}</span>
                            )}
                          </span>
                          <span className="flex-1 text-sm font-medium">
                            {step.name}
                          </span>
                          <Badge variant="outline">
                            {step.status === 'completed'
                              ? '完成'
                              : step.status === 'running'
                                ? '处理中'
                                : step.status === 'failed'
                                  ? '失败'
                                  : step.status === 'cooldown'
                                    ? '冷却中'
                                    : step.status === 'not_run'
                                      ? '未执行'
                                      : '等待'}
                          </Badge>
                        </div>
                      ))}
                      <section
                        className="pt-6"
                        aria-labelledby="hourly-collection-history-title"
                      >
                        <h3
                          id="hourly-collection-history-title"
                          className="text-sm font-medium"
                        >
                          近 24 小时实际采集记录
                        </h3>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {data.statusError ||
                          !Array.isArray(data.recentRuns) ||
                          !hourlyHistory.length
                            ? '采集记录暂时无法读取，不推测各小时是否执行。'
                            : hourlyHistory.every(
                                  (run) => run.status === 'not_run',
                                )
                              ? '当前环境近 24 小时暂无实际采集记录。未执行表示该小时没有采集记录。'
                              : '北京时间；未执行表示该小时没有采集记录，不代表冷却或成功。'}
                        </p>
                        <ol className="mt-3 grid list-none grid-cols-6 gap-2 p-0 sm:grid-cols-8">
                          {hourlyHistory.map((run) => (
                            <li
                              key={run.hour}
                              aria-label={`${formatBeijing(run.hour, true)} · ${hourlyCollectionLabel(run)}`}
                              title={`${formatBeijing(run.hour, true)} · ${hourlyCollectionLabel(run)}`}
                              className={`rounded-md border p-2 text-center text-xs ${run.status === 'completed' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700' : run.status === 'running' ? 'border-primary/20 bg-primary/10' : run.status === 'failed' ? 'border-destructive/20 bg-destructive/10 text-destructive' : run.status === 'cooldown' || run.status === 'deferred' ? 'border-amber-500/20 bg-amber-500/5 text-amber-700' : 'border-border bg-muted/40 text-muted-foreground'}`}
                            >
                              <div>{formatBeijing(run.hour).slice(-5)}</div>
                              <div className="mt-1">
                                {hourlyCollectionLabel(run)}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>
                    </CardContent>
                  </Card>
                  <div className="space-y-4">
                    <Card className="border-0 ring-1 ring-border">
                      <CardHeader>
                        <CardTitle className="text-sm font-semibold">
                          中文处理与预算
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2 text-xs leading-5 text-muted-foreground">
                        <p>
                          {data.aiConfigured
                            ? '免费 Workers AI 已配置。内容有变更或尚未翻译时才处理，避免重复消耗额度。'
                            : '中文服务尚未配置，当前展示原文，不伪装成已翻译。'}
                        </p>
                        <p>
                          本轮中文完成{' '}
                          {
                            data.stories.filter(
                              (story) => story.analysisStatus === 'completed',
                            ).length
                          }{' '}
                          / {data.stories.length}{' '}
                          篇。失败内容保留原帖，下次入榜时重试。
                        </p>
                        <p>
                          最多 128 次 AI 请求 / UTC
                          日；达到应用上限或免费额度后暂停，不自动升级付费。
                        </p>
                      </CardContent>
                    </Card>
                    <Card className="border-0 ring-1 ring-border">
                      <CardHeader>
                        <CardTitle className="text-sm font-semibold">
                          采集来源与限制
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="text-xs leading-5 text-muted-foreground">
                        {isIndexed
                          ? 'Arctic Shift 公开索引 API，无需付费密钥。每小时读取各社区最多 100 篇帖子，逐帖计数最多 40 篇新增候选及全部追踪帖；不读取留言正文。计数可能有索引延迟和补收，按实际观测间隔计算增速。排除来源可识别的删除和成人内容；限流时自动冷却。'
                          : isRssPreview
                            ? '每小时检查一次；只有冷却结束才请求公开合并 RSS。遇到 429 后按 1、2、4、8、16、24 小时逐步退避，并遵守更长的 Retry-After。冷却期间不补抓、不密集重试，旧榜单明确标记为上次成功资料。RSS 不提供点赞、评论数或浏览量。'
                            : 'OAuth 模式使用 Reddit Data API 的公开帖子与互动指标，不提供可依赖的真实浏览量。'}
                      </CardContent>
                    </Card>
                    <Card className="border-0 ring-1 ring-border">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                          <Clock3 className="size-4 text-primary" />
                          采集与报告排程
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-xs">
                        {scheduler ? (
                          <>
                            <div className="flex flex-wrap justify-between gap-2">
                              <span className="text-muted-foreground">
                                GitHub 正常采集
                              </span>
                              <span>每小时 :10</span>
                            </div>
                            <div className="flex flex-wrap justify-between gap-2">
                              <span className="text-muted-foreground">
                                Cloudflare 检查
                              </span>
                              <span>每小时 :00 / :25 / :50</span>
                            </div>
                            <p className="leading-5 text-muted-foreground">
                              :25 检查本小时资料，缺少完成记录时补触发
                              GitHub；:50 再检查。
                              检查或补触发成功后，仍须等待实际采集完成。
                            </p>
                          </>
                        ) : (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              小时审查
                            </span>
                            <span>每小时整点</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            历史日报
                          </span>
                          <span>北京 00:00</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            完整周报
                          </span>
                          <span>周一 00:10</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 ring-1 ring-border">
                      <CardHeader>
                        <CardTitle className="text-sm font-semibold">
                          合规保留策略
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="text-xs leading-5 text-muted-foreground">
                        小时榜首次采集 48 小时后清除 Reddit
                        短节录、链接与作者标识。 深度分析只保存最近 7
                        天的摘要卡片与原帖链接，不保存文章或留言正文；历史周报只保留去标识化摘要。
                      </CardContent>
                    </Card>
                    <Card className="border-0 ring-1 ring-border">
                      <CardHeader>
                        <CardTitle className="text-sm font-semibold">
                          技术来源
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="text-xs leading-5 text-muted-foreground">
                        批量抓取、内容清洗与结构化抽取设计参考 Crawl4AI by
                        UncleCode，并重写为 Cloudflare Worker 可运行的 Web API
                        管线。
                      </CardContent>
                    </Card>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
      <footer className="editorial-footer">
        <button onClick={() => navigate('status')}>
          <CircleDot aria-hidden="true" />
          {statusLabel} · 数据截至 {formatBeijing(data.updatedAt, true)}
          （北京时间）
        </button>
        <p>
          {view === 'deep'
            ? '仅提炼作者观点，不做全文翻译，请以原帖为准。'
            : '仅翻译标题与短节录，请以原帖为准。'}
        </p>
      </footer>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="editorial-dialog" showCloseButton={false}>
          <DialogTitle className="sr-only">贴文重点</DialogTitle>
          <DialogDescription className="sr-only">
            标题、简中摘要与原帖链接
          </DialogDescription>
          {selected ? (
            <StoryDetail story={selected} onClose={() => setSelected(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </main>
  );
}
