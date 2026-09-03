'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpenText,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  ExternalLink,
  Flame,
  Gauge,
  History,
  Languages,
  MessageCircle,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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

type ViewId = 'top' | 'tracking' | 'daily' | 'weekly' | 'authors' | 'status';

const navigation: Array<{ id: ViewId; label: string; icon: typeof Flame }> = [
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

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function RankChange({ story }: { story: DashboardStory }) {
  if (story.previousRank === null)
    return <span className="text-primary">新</span>;
  const difference = story.previousRank - story.rank;
  if (difference > 0)
    return (
      <span className="flex items-center text-emerald-600">
        <ArrowUp className="size-3" />
        {difference}
      </span>
    );
  if (difference < 0)
    return (
      <span className="flex items-center text-amber-600">
        <ArrowDown className="size-3" />
        {Math.abs(difference)}
      </span>
    );
  return <span className="text-muted-foreground">—</span>;
}

function TrendBars({
  values,
  compact = false,
}: {
  values: number[];
  compact?: boolean;
}) {
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

function StoryCard({
  story,
  onSelect,
}: {
  story: DashboardStory;
  onSelect: () => void;
}) {
  return (
    <Card
      size="sm"
      className="border-0 bg-card shadow-[0_1px_0_rgb(23_32_51/4%),0_12px_30px_-24px_rgb(23_32_51/35%)] ring-1 ring-border transition-transform hover:-translate-y-0.5"
    >
      <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 px-4 sm:gap-x-4 sm:px-5">
        <div
          className={`row-span-2 grid size-9 place-items-center rounded-xl text-sm font-bold ${story.rank === 1 ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}
        >
          {story.rank}
        </div>
        <div className="min-w-0">
          <CardTitle className="line-clamp-2 text-[15px] font-semibold sm:text-base">
            {story.title}
          </CardTitle>
          <CardDescription className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] sm:text-xs">
            <span className="font-medium text-[#d84a2b]">
              r/{story.subreddit}
            </span>
            <span>·</span>
            <span>u/{story.author}</span>
            <span>·</span>
            <span>{formatBeijing(story.publishedAt, true)}</span>
          </CardDescription>
        </div>
        <CardAction className="row-span-2 flex min-w-14 flex-col items-end">
          <span className="font-mono text-lg font-semibold tabular-nums">
            {Math.round(story.heat)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {story.metricsAvailable ? '互动热度' : '榜单指数'}
          </span>
          <span className="mt-1 text-[10px] font-medium">
            <RankChange story={story} />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 px-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
        <div>
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
            {story.summary}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {story.topics.slice(0, 3).map((topic) => (
              <Badge key={topic} variant="secondary" className="text-[10px]">
                {topic}
              </Badge>
            ))}
            {story.analysisStatus !== 'completed' &&
            story.analysisStatus !== 'demo' ? (
              <Badge variant="outline" className="text-[10px]">
                翻译处理中
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex items-end justify-between gap-4 sm:flex-col sm:items-end">
          <TrendBars values={story.trend.slice(-8)} compact />
          {story.metricsAvailable ? (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <TrendingUp className="size-3.5" />
                {compactNumber(story.score)}
              </span>
              <span className="flex items-center gap-1">
                <MessageCircle className="size-3.5" />
                {compactNumber(story.comments)}
              </span>
            </div>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              RSS 不提供互动数字
            </span>
          )}
        </div>
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-2 sm:px-5">
        <span className="text-[10px] text-muted-foreground">
          {story.metricsAvailable
            ? `热度速度 ${story.velocity.toFixed(2)}`
            : '依据 RSS 榜位、时效与 ETF 相关性'}
        </span>
        <div className="flex items-center gap-3">
          <RedditPostLink
            story={story}
            className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary hover:underline"
          />
          <button
            onClick={onSelect}
            className="flex min-h-8 items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            查看重点 <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    </Card>
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
    <Card className="sticky top-24 border-0 bg-[#172033] text-white ring-0">
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
        <div className="rounded-xl bg-white/7 p-3">
          <div className="mb-2 flex items-center justify-between text-[10px] text-white/50">
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
              <span className="text-[10px] text-muted-foreground">
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
            <p className="mt-5 text-[10px] text-muted-foreground">
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
  const [view, setView] = useState<ViewId>('top');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<DashboardStory | null>(null);
  const [isPending, startTransition] = useTransition();
  const isRssPreview = data.mode === 'rss-preview';
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

  const refresh = () =>
    startTransition(async () => {
      const response = await fetch('/api/dashboard', { cache: 'no-store' });
      if (response.ok) setData((await response.json()) as DashboardData);
    });

  const activeLabel = navigation.find((item) => item.id === view)?.label ?? '';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid min-h-screen max-w-[1600px] lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden border-r border-sidebar-border bg-sidebar px-5 py-6 lg:flex lg:flex-col">
          <div className="flex items-center gap-3 px-2">
            <div className="grid size-10 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[0_8px_24px_-10px_var(--primary)]">
              <Radio className="size-5" strokeWidth={2.4} />
            </div>
            <div>
              <p className="font-heading text-[15px] font-semibold tracking-tight">
                etfs热门话题
              </p>
              <p className="text-[11px] text-muted-foreground">
                Reddit ETF 情报台
              </p>
            </div>
          </div>
          <nav className="mt-9 space-y-1" aria-label="主要导航">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm transition-colors ${view === item.id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="mt-auto rounded-2xl border border-sidebar-border bg-background/70 p-4">
            <div className="flex items-center gap-2 text-xs font-medium">
              <ShieldCheck className="size-4 text-emerald-600" />
              数据边界已锁定
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              仅访问 Reddit 帖文，不抓取帖子中的站外文章。
            </p>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="sticky top-0 z-20 border-b border-border/80 bg-background/90 px-4 backdrop-blur-xl sm:px-7">
            <div className="flex h-16 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3 lg:hidden">
                <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
                  <Radio className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">etfs热门话题</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {activeLabel}
                  </p>
                </div>
              </div>
              <div className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
                <CircleDot
                  className={`size-3.5 ${data.status === 'healthy' ? 'fill-emerald-500 text-emerald-500' : data.status === 'delayed' ? 'fill-amber-500 text-amber-500' : 'fill-sky-500 text-sky-500'}`}
                />
                {data.cooldownUntil
                  ? 'Reddit 限流，冷却中'
                  : data.status === 'healthy'
                    ? '采集器运行正常'
                    : data.status === 'delayed'
                      ? '采集延迟，沿用上次成功结果'
                      : '等待更多小时数据'}
                <span className="text-border">•</span>数据截至{' '}
                {formatBeijing(data.updatedAt)}（北京时间）
              </div>
              <div className="flex items-center gap-2">
                <div className="relative hidden sm:block">
                  <Search className="absolute left-2.5 top-2 size-4 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索话题、社区或作者"
                    className="w-56 pl-8"
                  />
                </div>
                <Button onClick={refresh} size="sm" disabled={isPending}>
                  <RefreshCw
                    data-icon="inline-start"
                    className={isPending ? 'animate-spin' : ''}
                  />
                  刷新状态
                </Button>
              </div>
            </div>
            <nav
              className="flex gap-1 overflow-x-auto pb-2 lg:hidden"
              aria-label="移动导航"
            >
              {navigation.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`min-h-9 shrink-0 rounded-lg px-3 text-xs ${view === item.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </header>

          <div className="px-4 py-5 sm:px-7 sm:py-7">
            <div className="mx-auto max-w-[1180px]">
              <div className="mb-7 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge className="bg-[#ff5a36]/12 text-[#d63f1f]">
                      仅采集 Reddit
                    </Badge>
                    <Badge variant="outline">
                      {data.mode === 'demo'
                        ? '演示数据'
                        : isRssPreview
                          ? 'RSS 预览・私有测试'
                          : 'OAuth 数据'}
                    </Badge>
                  </div>
                  <h1 className="font-heading text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">
                    {view === 'top' ? '最近成功采集的 ETF 讨论' : activeLabel}
                  </h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                    {view === 'top'
                      ? isRssPreview
                        ? '按 Reddit RSS 榜单顺序、发布时间与 ETF 相关性排序；RSS 不提供点赞、评论数或浏览量。'
                        : '按互动增速、评论量、作者影响力与 ETF 相关性综合排序，并自动翻译为简体中文。'
                      : view === 'tracking'
                        ? isRssPreview
                          ? '同一帖子跨小时去重，记录最多 24 小时的入榜轨迹；未出现在本轮 RSS 不代表已删除。'
                          : '同一帖子跨小时去重，保留最多 24 个小时的热度轨迹。'
                        : view === 'authors'
                          ? isRssPreview
                            ? '只统计作者在本采集器中的入榜活跃度，不能据此认定为 KOL。'
                            : '热门作者是站内互动影响力估算，并非 Reddit 官方认证身份。'
                          : view === 'status'
                            ? '查看发现、验证、排名、翻译与报告各环节的最近状态。'
                            : '所有统计按北京时间自然日归档，原始时间统一以 UTC 保存。'}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                  {[
                    [
                      '上次成功候选',
                      data.updatedAt ? String(data.candidateCount) : '—',
                    ],
                    ['24h 席位', `${data.rankSlots24h} / 120`],
                    ['近 24h 成功', `${data.completedHours24h} / 24`],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl border border-border bg-card px-3 py-2.5 sm:min-w-28"
                    >
                      <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                        {label}
                      </p>
                      <p className="mt-1 text-sm font-semibold tabular-nums">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {data.cooldownUntil ||
              data.latestAttempt?.error ||
              data.statusError ||
              data.status === 'delayed' ? (
                <section
                  aria-label="采集状态提示"
                  aria-live="polite"
                  className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm"
                >
                  <p className="font-semibold">
                    {data.cooldownUntil
                      ? 'Reddit 限流，已暂停请求并进入冷却'
                      : data.statusError
                        ? '运行状态暂不可用'
                        : data.latestAttempt?.error
                          ? '最近一轮未取得完整新数据'
                          : '当前展示较早的成功数据'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {data.statusError ??
                      data.latestAttempt?.error ??
                      '没有把旧资料当成本小时的新采集结果。'}
                    {data.cooldownUntil
                      ? ` 冷却期间不会请求 Reddit；预计 ${formatBeijing(data.nextRetryAt, true)} 的整点排程恢复尝试（北京时间，不保证届时限流解除）。`
                      : ''}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    最后成功：{formatBeijing(data.updatedAt, true)}
                    ；最新排程检查：
                    {formatBeijing(data.latestAttempt?.startedAt, true)}。
                    刷新状态只读取现有记录，不会触发采集。
                  </p>
                </section>
              ) : null}

              {view === 'top' ? (
                <div
                  className={`grid gap-5 ${selected ? 'xl:grid-cols-[minmax(0,1fr)_320px]' : 'xl:grid-cols-[minmax(0,1fr)_300px]'}`}
                >
                  <section aria-labelledby="ranking-title">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Flame className="size-4 text-primary" />
                        <h2
                          id="ranking-title"
                          className="text-sm font-semibold"
                        >
                          最新成功榜单 Top 5
                        </h2>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {isRssPreview ? 'RSS 榜内优先级' : '综合互动热度'}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {filteredStories.length ? (
                        filteredStories.map((story) => (
                          <StoryCard
                            key={story.id}
                            story={story}
                            onSelect={() => setSelected(story)}
                          />
                        ))
                      ) : (
                        <Empty>
                          {data.stories.length
                            ? '没有符合当前搜索条件的帖子。'
                            : '尚无成功采集的榜单。请查看运行状态；这里不会使用示范资料代替。'}
                        </Empty>
                      )}
                    </div>
                  </section>
                  <aside className="space-y-4">
                    {selected ? (
                      <StoryDetail
                        story={selected}
                        onClose={() => setSelected(null)}
                      />
                    ) : (
                      <>
                        <Card className="border-0 bg-[#172033] text-white ring-0">
                          <CardHeader>
                            <div className="mb-3 grid size-9 place-items-center rounded-xl bg-white/10">
                              <Sparkles className="size-4 text-[#ff8a66]" />
                            </div>
                            <CardTitle className="text-base font-semibold">
                              今日情报速览
                            </CardTitle>
                            <CardDescription className="text-white/55">
                              北京时间 00:00 自动归档
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-4">
                            <p className="text-sm leading-6 text-white/78">
                              {data.dailyReports[0]?.summary ??
                                '今日报告将在日界后自动生成。'}
                            </p>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="rounded-xl bg-white/7 p-3">
                                <p className="font-mono text-lg font-semibold">
                                  {data.uniquePosts24h}
                                </p>
                                <p className="text-[10px] text-white/50">
                                  唯一帖子
                                </p>
                              </div>
                              <div className="rounded-xl bg-white/7 p-3">
                                <p className="font-mono text-lg font-semibold">
                                  {data.activeTracked}
                                </p>
                                <p className="text-[10px] text-white/50">
                                  追踪中
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => setView('daily')}
                              className="flex min-h-10 w-full items-center justify-between rounded-xl border border-white/10 px-3 text-xs font-medium hover:bg-white/5"
                            >
                              打开今日预览 <ArrowUpRight className="size-3.5" />
                            </button>
                          </CardContent>
                        </Card>
                        <div className="rounded-xl border border-dashed border-border px-4 py-3 text-[11px] leading-5 text-muted-foreground">
                          <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                            <Languages className="size-3.5" />
                            翻译说明
                          </div>
                          仅翻译标题与 RSS 中可见的短节录；ETF 代码、数值和
                          Reddit 原始链接保留原样，请以原帖为准。
                        </div>
                      </>
                    )}
                  </aside>
                </div>
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
                            <span className="text-[10px] text-muted-foreground">
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
                          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                            <div>
                              <p className="font-mono text-base font-semibold">
                                {Math.round(story.heat)}
                              </p>
                              <p className="text-[10px] text-muted-foreground">
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
                                  <p className="text-[10px] text-muted-foreground">
                                    最新评论
                                  </p>
                                </div>
                                <div>
                                  <p className="font-mono text-base font-semibold">
                                    {story.velocity.toFixed(1)}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">
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
                                  <p className="text-[10px] text-muted-foreground">
                                    入榜观察
                                  </p>
                                </div>
                                <div>
                                  <p className="font-mono text-base font-semibold">
                                    RSS
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">
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
                      {isRssPreview ? '活跃作者观察' : '热门作者观察'}
                    </CardTitle>
                    <CardDescription>
                      {isRssPreview
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
                            {isRssPreview ? '观察活跃度' : '影响力'}
                          </TableHead>
                          <TableHead>观察帖子</TableHead>
                          <TableHead>
                            {isRssPreview ? '入榜率' : '热门命中率'}
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
                        当前唯一数据来源：Reddit{' '}
                        {isRssPreview ? 'RSS' : 'OAuth'}。
                      </strong>{' '}
                      {isRssPreview
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
                        最新排程检查与采集状态
                      </CardTitle>
                      <CardDescription>
                        本次排程时点：
                        {formatBeijing(data.latestAttempt?.logicalHour, true)}
                        ；检查于{' '}
                        {formatBeijing(data.latestAttempt?.startedAt, true)}
                        （北京时间）
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      <dl className="mb-4 grid gap-3 rounded-xl bg-muted/50 p-4 text-xs sm:grid-cols-2">
                        <div>
                          <dt className="text-muted-foreground">
                            最后成功取得数据
                          </dt>
                          <dd className="mt-1 font-medium">
                            {formatBeijing(data.updatedAt, true)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            最近实际请求 Reddit RSS
                          </dt>
                          <dd className="mt-1 font-medium">
                            {isRssPreview
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
                      {data.latestAttempt?.stage === 'preparing' ||
                      data.latestAttempt?.stage === 'unknown' ? (
                        <p className="py-2 text-xs text-muted-foreground">
                          {data.latestAttempt.status === 'running'
                            ? '正在准备采集和执行保留清理。'
                            : '旧记录或准备阶段未提供具体步骤；以下不会推测成 RSS 故障。'}
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
                    </CardContent>
                  </Card>
                  <div className="space-y-4">
                    <Card className="border-0 ring-1 ring-border">
                      <CardHeader>
                        <CardTitle className="text-sm font-semibold">
                          采集来源与限制
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="text-xs leading-5 text-muted-foreground">
                        {isRssPreview
                          ? '每小时检查一次；只有冷却结束才请求公开合并 RSS。遇到 429 后按 1、2、4、8、16、24 小时逐步退避，并遵守更长的 Retry-After。冷却期间不补抓、不密集重试，旧榜单明确标记为上次成功资料。RSS 不提供点赞、评论数或浏览量。'
                          : 'OAuth 模式使用 Reddit Data API 的公开帖子与互动指标，不提供可依赖的真实浏览量。'}
                      </CardContent>
                    </Card>
                    <Card className="border-0 ring-1 ring-border">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                          <Clock3 className="size-4 text-primary" />
                          Cloudflare 排程
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-xs">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            小时审查
                          </span>
                          <span>每小时整点</span>
                        </div>
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
                        首次采集 48 小时后清除 Reddit
                        短节录、链接与作者标识；历史页只保留去标识化聚合报告。
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
    </main>
  );
}
