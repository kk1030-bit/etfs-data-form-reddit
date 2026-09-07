'use client';

import { ArrowRight, ArrowUpRight, Radio } from 'lucide-react';
import Image from 'next/image';

import type { DashboardData, DashboardStory } from '@/lib/dashboard-data';
import './lead-topics.css';

export type LeadTopicsProps = {
  data: DashboardData;
  stories: DashboardStory[];
  onSelect: (story: DashboardStory) => void;
  onDaily: () => void;
};

function publishedTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return '发布时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function numberLabel(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function StoryMeta({ story }: { story: DashboardStory }) {
  return (
    <p className="lead-story-meta">
      <span>r/{story.subreddit}</span>
      <span aria-hidden="true">·</span>
      <span>u/{story.author}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={story.publishedAt} title="北京时间">
        {publishedTime(story.publishedAt)}
      </time>
    </p>
  );
}

function TranslationState({ story }: { story: DashboardStory }) {
  if (story.analysisStatus === 'completed' || story.analysisStatus === 'demo') {
    return null;
  }
  return (
    <span className="lead-translation-state">
      {story.analysisStatus === 'failed' ? '翻译暂未完成' : '待生成中文摘要'}
    </span>
  );
}

function OriginalLink({ story }: { story: DashboardStory }) {
  return (
    <a
      className="lead-original-link"
      href={story.permalink}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Reddit 原帖：${story.originalTitle}（新窗口打开）`}
    >
      Reddit 原帖 <ArrowUpRight size={17} aria-hidden="true" />
    </a>
  );
}

function DiscussionMetric({ story }: { story: DashboardStory }) {
  if (story.metricsAvailable) {
    return (
      <span>
        {numberLabel(story.score)} 赞 · {numberLabel(story.comments)} 条评论
      </span>
    );
  }
  if (story.sourceProvider === 'arctic-shift') {
    return (
      <span>已索引讨论样本 {numberLabel(story.discussionCount ?? 0)} 条</span>
    );
  }
  return <span>RSS 不提供互动数字</span>;
}

function HeroMetrics({ story }: { story: DashboardStory }) {
  const indexed = story.sourceProvider === 'arctic-shift';
  return (
    <div className="lead-hero-metrics">
      <div className="lead-hero-metric">
        <span className="lead-metric-value lead-metric-primary">
          {numberLabel(story.heat)}
        </span>
        <span className="lead-metric-label">
          {story.metricsAvailable ? '互动热度' : '榜单指数'}
        </span>
      </div>
      {story.metricsAvailable || indexed ? (
        <div className="lead-hero-metric">
          <span className="lead-metric-value">
            {numberLabel(
              story.metricsAvailable
                ? story.comments
                : (story.discussionCount ?? 0),
            )}
          </span>
          <span className="lead-metric-label">
            {story.metricsAvailable ? '评论数' : '已索引讨论样本'}
          </span>
        </div>
      ) : (
        <p className="lead-metric-unavailable">RSS 不提供互动数字</p>
      )}
    </div>
  );
}

export function LeadTopics({
  data,
  stories,
  onSelect,
  onDaily,
}: LeadTopicsProps) {
  const [hero, ...remaining] = stories;
  const latestReport = data.dailyReports[0];
  const titleLength = Array.from(hero?.title ?? '').length;
  const titleSize =
    titleLength <= 12 ? 'short' : titleLength <= 26 ? 'medium' : 'long';

  return (
    <div className="lead-topics">
      {hero ? (
        <div className="lead-stories-layout">
          <article className="lead-hero" aria-labelledby="lead-hero-title">
            <Image
              className="lead-particle-field"
              src="/images/lead-particle-field.webp"
              alt=""
              aria-hidden="true"
              width={1024}
              height={1024}
              decoding="async"
              unoptimized
            />
            <span className="lead-hero-rank" aria-label={`排名 ${hero.rank}`}>
              {String(hero.rank).padStart(2, '0')}
            </span>
            <h1
              className="lead-hero-title"
              id="lead-hero-title"
              data-size={titleSize}
            >
              {hero.title}
            </h1>
            <StoryMeta story={hero} />
            <p className="lead-hero-summary">{hero.summary}</p>
            <div className="lead-topic-tags">
              {hero.topics.slice(0, 3).map((topic) => (
                <span className="lead-topic-tag" key={topic}>
                  {topic}
                </span>
              ))}
              <TranslationState story={hero} />
            </div>
            <div className="lead-hero-actions">
              <button
                className="lead-details-button"
                onClick={() => onSelect(hero)}
              >
                查看重点 <ArrowRight size={22} aria-hidden="true" />
              </button>
              <OriginalLink story={hero} />
            </div>
            <HeroMetrics story={hero} />
          </article>

          <section className="lead-more" aria-labelledby="lead-more-title">
            <h2 id="lead-more-title" className="lead-more-title">
              更多热门讨论
            </h2>
            {remaining.length ? (
              <ol className="lead-story-list">
                {remaining.map((story) => (
                  <li
                    className="lead-story-row"
                    key={story.id}
                    value={story.rank}
                  >
                    <span
                      className="lead-row-rank"
                      aria-label={`排名 ${story.rank}`}
                    >
                      {String(story.rank).padStart(2, '0')}
                    </span>
                    <article className="lead-row-content">
                      <h3 className="lead-row-title">
                        <button onClick={() => onSelect(story)}>
                          {story.title}
                        </button>
                      </h3>
                      <StoryMeta story={story} />
                      <p className="lead-row-summary">{story.summary}</p>
                      <TranslationState story={story} />
                      <div className="lead-row-bottom">
                        <p className="lead-row-metrics">
                          <span>
                            {story.metricsAvailable ? '互动热度' : '榜单指数'}{' '}
                            <strong>{numberLabel(story.heat)}</strong>
                          </span>
                          <span
                            className="lead-metric-separator"
                            aria-hidden="true"
                          >
                            ·
                          </span>
                          <DiscussionMetric story={story} />
                        </p>
                        <OriginalLink story={story} />
                      </div>
                    </article>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="lead-more-empty">
                {data.stories.length > stories.length
                  ? '没有其他符合搜索条件的讨论。'
                  : '本轮没有其他入榜讨论。'}
              </div>
            )}
          </section>
        </div>
      ) : (
        <section className="lead-empty" aria-labelledby="lead-empty-title">
          <span className="lead-empty-mark" aria-hidden="true">
            —
          </span>
          <h2 id="lead-empty-title">
            {data.stories.length ? '没有找到相关讨论' : '等待下一轮真实数据'}
          </h2>
          <p>
            {data.stories.length
              ? '请尝试其他话题、社区或作者关键词。'
              : '当前还没有可展示的成功榜单。采集状态与来源限制可在运行状态中查看。'}
          </p>
        </section>
      )}

      <section className="lead-daily" aria-labelledby="lead-daily-title">
        <div className="lead-daily-intro">
          <div className="lead-daily-mark" aria-hidden="true">
            <Radio size={30} strokeWidth={1.6} />
          </div>
          <div className="lead-daily-copy">
            <h2 id="lead-daily-title">今日情报速览</h2>
            <p>
              {latestReport
                ? `${latestReport.label} 日报 · ${latestReport.summary}`
                : '今日报告将在日界后自动生成。'}
            </p>
          </div>
        </div>
        <dl className="lead-daily-stats">
          <div>
            <dd>{numberLabel(data.uniquePosts24h)}</dd>
            <dt>近 24h 唯一帖子</dt>
          </div>
          <div>
            <dd>{numberLabel(data.activeTracked)}</dd>
            <dt>追踪中</dt>
          </div>
        </dl>
        <button className="lead-daily-button" onClick={onDaily}>
          查看历史日报 <ArrowUpRight size={18} aria-hidden="true" />
        </button>
      </section>
    </div>
  );
}
