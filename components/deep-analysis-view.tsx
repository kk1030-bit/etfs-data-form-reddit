import { ExternalLink, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { DeepData } from '@/lib/collector/deep-analysis-store';
import {
  compareDeepRecent,
  deepIsNew,
  DEEP_WINDOW_MS,
} from '@/lib/collector/deep-analysis-dates';

const beijing = (at: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at));
export function DeepAnalysisView({
  data,
  query,
  nowMs,
}: {
  data?: DeepData;
  query: string;
  nowMs: number;
}) {
  const now = nowMs,
    needle = query.trim().toLowerCase();
  const articles = (data?.articles ?? [])
    .filter((a) => {
      const published = Date.parse(a.publishedAt);
      return (
        published >= now - DEEP_WINDOW_MS &&
        published <= now &&
        (!needle ||
          [a.title, a.subreddit, a.author, a.thesis, ...a.tickers]
            .join(' ')
            .toLowerCase()
            .includes(needle))
      );
    })
    .sort(compareDeepRecent);
  const status = data?.lastRun;
  return (
    <section aria-label="深度分析文章" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-4 text-sm text-muted-foreground">
        <p>每日北京 08:30 审查 · 最近 7 天 · 按原帖发布时间由新到旧</p>
        <p>
          {articles.length} 篇{needle ? '匹配文章' : '通过审查'}
        </p>
      </div>
      {data?.error ? (
        <output className="rounded-xl border border-amber-500/30 p-4 text-sm">
          {data.error}
        </output>
      ) : null}
      {status && status.status !== 'completed' ? (
        <output className="block text-sm text-muted-foreground">
          {status.status === 'partial'
            ? `最近一次审查有 ${status.failed} 篇处理未完成；只展示已通过审查的文章。`
            : status.status === 'failed'
              ? '最近一次采集未完成，保留仍在 7 天范围内的已审查文章。'
              : '最近一轮审查尚未完成。'}
        </output>
      ) : null}
      {!articles.length ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <FileText
            aria-hidden="true"
            className="mx-auto mb-4 size-6 text-primary"
          />
          <p className="text-base">
            {needle
              ? '没有匹配的近期分析文章'
              : !status
                ? '深度分析尚未完成首次每日审查'
                : '最近 7 天暂无通过审查的分析文章'}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            仅展示初评分至少 55
            分且通过内容审查的文章，不用旧文或未审查内容补位。
          </p>
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {articles.map((article) => (
            <Card
              key={article.id}
              className="flex h-full flex-col border-0 ring-1 ring-border"
            >
              <CardHeader className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="text-primary">r/{article.subreddit}</span>
                  <div className="flex items-center gap-2">
                    {deepIsNew(article.publishedAt, now) ? (
                      <Badge>新</Badge>
                    ) : null}
                    <span
                      className="tabular-nums text-muted-foreground"
                      title="正文评分与索引讨论信号，不是收益或浏览量"
                    >
                      筛选分 {article.score.toFixed(1)}
                    </span>
                  </div>
                </div>
                <CardTitle className="text-xl font-medium leading-relaxed">
                  {article.title}
                </CardTitle>
                <p className="text-sm leading-6 text-muted-foreground">
                  u/{article.author}
                  {article.authorFlair
                    ? ` · ${article.authorFlair}（自述 flair）`
                    : ''}
                </p>
                <p className="text-sm text-muted-foreground">
                  发布于{' '}
                  <time dateTime={article.publishedAt}>
                    {beijing(article.publishedAt)}
                  </time>
                  （北京）
                </p>
                <p className="text-sm text-muted-foreground">
                  正文 {article.characters.toLocaleString('zh-CN')} 字符 · 约{' '}
                  {article.readingMinutes} 分钟阅读
                </p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    一手来源 {article.primarySourceCount} 个
                  </Badge>
                  {article.hasTable ? (
                    <Badge variant="outline">含数据表</Badge>
                  ) : null}
                  <Badge variant="outline">
                    {article.authorLongPosts === null
                      ? '作者长文记录暂不可用'
                      : `作者 90 天长文 ${article.authorLongPosts} 篇`}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1 space-y-5 text-base leading-7">
                <div>
                  <h3 className="mb-1 text-sm font-semibold text-primary">
                    论点
                  </h3>
                  <p>{article.thesis}</p>
                </div>
                <div>
                  <h3 className="mb-1 text-sm font-semibold text-primary">
                    关键数据
                  </h3>
                  {article.keyData.length ? (
                    <ul className="list-disc space-y-1 pl-5">
                      {article.keyData.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">
                      原文未提供可提取的关键数据。
                    </p>
                  )}
                </div>
                <div>
                  <h3 className="mb-1 text-sm font-semibold text-primary">
                    反方观点
                  </h3>
                  <p>{article.counterpoints}</p>
                </div>
                {article.backgroundClaimed ? (
                  <p className="text-sm text-muted-foreground">
                    作者自述：{article.backgroundClaimed}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {article.uniqueCommenters === null
                    ? '独立留言者计数暂不可用'
                    : `已索引独立留言者 ${article.uniqueCommenters} 人`}{' '}
                  · 索引可能延迟，不代表实时完整讨论量。
                </p>
              </CardContent>
              <CardFooter className="mt-auto flex-col items-stretch gap-3 border-t border-border pt-5 text-sm">
                <a
                  href={article.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 items-center justify-between text-primary"
                  aria-label={`打开 Reddit 原帖：${article.title}`}
                >
                  阅读原帖{' '}
                  <ExternalLink aria-hidden="true" className="size-4" />
                </a>
                <p className="text-muted-foreground">
                  作者背景为自述，本站未验证
                </p>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
