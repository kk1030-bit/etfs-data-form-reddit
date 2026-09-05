import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const redditPosts = sqliteTable(
  'reddit_posts',
  {
    id: text('id').primaryKey(),
    redditId: text('reddit_id').notNull(),
    subreddit: text('subreddit').notNull(),
    author: text('author'),
    permalink: text('permalink').notNull(),
    outboundUrl: text('outbound_url'),
    titleOriginal: text('title_original').notNull(),
    bodyOriginal: text('body_original').notNull().default(''),
    titleZh: text('title_zh'),
    translationZh: text('translation_zh'),
    summaryZh: text('summary_zh'),
    highlightsJson: text('highlights_json').notNull().default('[]'),
    topicsJson: text('topics_json').notNull().default('[]'),
    contentHash: text('content_hash').notNull(),
    analysisStatus: text('analysis_status').notNull().default('pending'),
    sourcePlatform: text('source_platform').notNull().default('reddit'),
    sourceProvider: text('source_provider').notNull().default('reddit'),
    indexedAtUtc: text('indexed_at_utc'),
    createdAtUtc: text('created_at_utc').notNull(),
    firstSeenAtUtc: text('first_seen_at_utc').notNull(),
    lastSeenAtUtc: text('last_seen_at_utc').notNull(),
    deletedAtUtc: text('deleted_at_utc'),
  },
  (table) => [
    uniqueIndex('uidx_reddit_posts_reddit_id').on(table.redditId),
    uniqueIndex('uidx_reddit_posts_permalink').on(table.permalink),
    index('idx_reddit_posts_last_seen').on(table.lastSeenAtUtc),
    index('idx_reddit_posts_author').on(table.author),
    check('chk_reddit_posts_source', sql`${table.sourcePlatform} = 'reddit'`),
  ],
);

export const postObservations = sqliteTable(
  'post_observations',
  {
    postId: text('post_id')
      .notNull()
      .references(() => redditPosts.id, { onDelete: 'cascade' }),
    observedHourUtc: text('observed_hour_utc').notNull(),
    observedAtUtc: text('observed_at_utc').notNull(),
    score: integer('score').notNull(),
    comments: integer('comments').notNull(),
    upvoteRatio: real('upvote_ratio').notNull(),
    metricsAvailable: integer('metrics_available', { mode: 'boolean' })
      .notNull()
      .default(true),
    bestListingRank: integer('best_listing_rank'),
    velocityScore: real('velocity_score').notNull(),
    heatScore: real('heat_score').notNull(),
    discussionCount: integer('discussion_count').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.observedHourUtc] }),
    index('idx_post_observations_hour').on(table.observedHourUtc),
  ],
);

export const hourlyRuns = sqliteTable('hourly_runs', {
  logicalHourUtc: text('logical_hour_utc').primaryKey(),
  startedAtUtc: text('started_at_utc').notNull(),
  completedAtUtc: text('completed_at_utc'),
  status: text('status').notNull(),
  sourceMode: text('source_mode').notNull().default('oauth'),
  candidateCount: integer('candidate_count').notNull().default(0),
  selectedCount: integer('selected_count').notNull().default(0),
  error: text('error'),
  stage: text('stage').notNull().default('unknown'),
  upstreamStatus: integer('upstream_status'),
  retryAtUtc: text('retry_at_utc'),
  sourceDetailsJson: text('source_details_json').notNull().default('{}'),
});

export const aiDailyUsage = sqliteTable('ai_daily_usage', {
  day: text('day').primaryKey(),
  requests: integer('requests').notNull().default(0),
});

export const redditSourceState = sqliteTable('reddit_source_state', {
  source: text('source').primaryKey(),
  consecutive429: integer('consecutive_429').notNull().default(0),
  cooldownUntilUtc: text('cooldown_until_utc'),
  lastAttemptAtUtc: text('last_attempt_at_utc'),
  lastError: text('last_error'),
  leaseToken: text('lease_token'),
  leaseUntilUtc: text('lease_until_utc'),
});

export const hourlyRankings = sqliteTable(
  'hourly_rankings',
  {
    logicalHourUtc: text('logical_hour_utc')
      .notNull()
      .references(() => hourlyRuns.logicalHourUtc, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    postId: text('post_id')
      .notNull()
      .references(() => redditPosts.id, { onDelete: 'cascade' }),
    heatScore: real('heat_score').notNull(),
    componentsJson: text('components_json').notNull(),
    previousRank: integer('previous_rank'),
  },
  (table) => [
    primaryKey({ columns: [table.logicalHourUtc, table.rank] }),
    uniqueIndex('uidx_hourly_rankings_hour_post').on(
      table.logicalHourUtc,
      table.postId,
    ),
    index('idx_hourly_rankings_post').on(table.postId),
  ],
);

export const trackingEpisodes = sqliteTable(
  'tracking_episodes',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => redditPosts.id, { onDelete: 'cascade' }),
    startedAtUtc: text('started_at_utc').notNull(),
    expiresAtUtc: text('expires_at_utc').notNull(),
    lastSelectedAtUtc: text('last_selected_at_utc').notNull(),
    selectedCount: integer('selected_count').notNull().default(1),
    status: text('status').notNull().default('active'),
  },
  (table) => [
    index('idx_tracking_episodes_status_expires').on(
      table.status,
      table.expiresAtUtc,
    ),
    uniqueIndex('uidx_tracking_episodes_post_start').on(
      table.postId,
      table.startedAtUtc,
    ),
  ],
);

export const authorMetrics = sqliteTable('author_metrics', {
  author: text('author').primaryKey(),
  influenceScore: real('influence_score').notNull().default(0.5),
  observedPosts: integer('observed_posts').notNull().default(0),
  topHitRate: real('top_hit_rate').notNull().default(0),
  subredditCount: integer('subreddit_count').notNull().default(0),
  computedAtUtc: text('computed_at_utc').notNull(),
});

export const authorObservations = sqliteTable(
  'author_observations',
  {
    author: text('author').notNull(),
    postId: text('post_id').notNull(),
    firstSeenAtUtc: text('first_seen_at_utc').notNull(),
    subreddit: text('subreddit').notNull(),
    peakHeatScore: real('peak_heat_score').notNull(),
    isTopHit: integer('is_top_hit').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.author, table.postId] }),
    index('idx_author_observations_first_seen').on(table.firstSeenAtUtc),
    index('idx_author_observations_author').on(table.author),
  ],
);

export const dailyReports = sqliteTable('daily_reports', {
  reportDate: text('report_date').primaryKey(),
  periodStartUtc: text('period_start_utc').notNull(),
  periodEndUtc: text('period_end_utc').notNull(),
  generatedAtUtc: text('generated_at_utc').notNull(),
  headline: text('headline').notNull(),
  executiveSummary: text('executive_summary').notNull(),
  sectionsJson: text('sections_json').notNull(),
  coverageSuccess: integer('coverage_success').notNull(),
  coverageExpected: integer('coverage_expected').notNull().default(24),
  version: integer('version').notNull().default(1),
});

export const weeklyReports = sqliteTable('weekly_reports', {
  weekStartDate: text('week_start_date').primaryKey(),
  periodStartUtc: text('period_start_utc').notNull(),
  periodEndUtc: text('period_end_utc').notNull(),
  generatedAtUtc: text('generated_at_utc').notNull(),
  headline: text('headline').notNull(),
  executiveSummary: text('executive_summary').notNull(),
  sectionsJson: text('sections_json').notNull(),
  daysIncluded: integer('days_included').notNull(),
  version: integer('version').notNull().default(1),
});

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    jobType: text('job_type').notNull(),
    logicalTimeUtc: text('logical_time_utc').notNull(),
    startedAtUtc: text('started_at_utc').notNull(),
    completedAtUtc: text('completed_at_utc'),
    status: text('status').notNull(),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('uidx_job_runs_type_time').on(
      table.jobType,
      table.logicalTimeUtc,
    ),
    index('idx_job_runs_status').on(table.status, table.startedAtUtc),
  ],
);

export const titleIndexRuns = sqliteTable('title_index_runs', {
  logicalHourUtc: text('logical_hour_utc').primaryKey(),
  checkedAtUtc: text('checked_at_utc').notNull(),
  status: text('status').notNull(),
  sourceCount: integer('source_count').notNull().default(0),
  itemsJson: text('items_json').notNull().default('[]'),
  error: text('error'),
});
