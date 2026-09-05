import {
  clampRawRetentionHours,
  chunksForD1,
  containsRedditUserHandle,
  DEFAULT_ETF_KEYWORDS,
  logicalHourIso,
  MAX_TRACKED_POSTS,
  mergeCandidate,
  normalizeRedditPost,
  parseCsv,
  previousBeijingDayWindow,
  previousBeijingWeekWindow,
  scoreCandidates,
  safeReportTopicLabels,
  selectTopStories,
  sha256Hex,
  type PreviousObservation,
  type RedditCandidate,
  type ScoredCandidate,
} from './core.ts';
import {
  analyzePost,
  hasLlmProvider,
  summarizeReport,
  type LlmEnv,
  type ReportAnalysis,
} from './llm.ts';
import {
  createRedditSession,
  discoverRedditCandidates,
  redditSourceMode,
  refreshTrackedPosts,
  type RedditEnv,
} from './reddit.ts';
import { RedditRssError } from './reddit-rss.ts';
import { RssDeferredError, withRssCooldown } from './rss-cooldown.ts';
import type { RunStage } from './collection-status.ts';
import { normalizeIndexedPost } from './arctic-shift.ts';

export type CollectorEnv = RedditEnv &
  LlmEnv & {
    DB: D1Database;
    JOB_SECRET?: string;
    RAW_CONTENT_RETENTION_HOURS?: string;
  };

type JobKind = 'hourly' | 'daily' | 'weekly';

type ActiveTracker = {
  id: string;
  postId: string;
  startedAtUtc: string;
  expiresAtUtc: string;
};

type ExistingPost = {
  id: string;
  contentHash: string;
  analysisStatus: string;
};

export type JobResult = {
  status: 'completed' | 'skipped' | 'cooldown' | 'deferred';
  kind: JobKind;
  logicalTimeUtc: string;
  selected?: number;
  candidates?: number;
  reportLabel?: string;
  sourceMode?: 'rss-preview' | 'oauth' | 'arctic-shift';
  retryAtUtc?: string;
  upstreamStatus?: number;
  reason?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 2_000)
    : String(error).slice(0, 2_000);
}

async function acquireJob(
  db: D1Database,
  kind: JobKind,
  logicalTimeUtc: string,
  sourceMode = '',
): Promise<boolean> {
  const id = `${kind}:${logicalTimeUtc}`;
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 20 * 60 * 1_000).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO job_runs
        (id, job_type, logical_time_utc, started_at_utc, status)
       VALUES (?1, ?2, ?3, ?4, 'running')
       ON CONFLICT(id) DO UPDATE SET
         started_at_utc = excluded.started_at_utc,
         completed_at_utc = NULL,
         status = 'running',
         error = NULL
       WHERE job_runs.status = 'failed'
          OR (job_runs.status IN ('cooldown', 'deferred') AND EXISTS (
            SELECT 1 FROM hourly_runs hr
            WHERE hr.logical_hour_utc = job_runs.logical_time_utc
              AND (hr.retry_at_utc <= excluded.started_at_utc OR (?6 <> '' AND hr.source_mode <> ?6))
          ))
          OR (job_runs.status = 'running' AND job_runs.started_at_utc < ?5)`,
    )
    .bind(id, kind, logicalTimeUtc, now, stale, sourceMode)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function finishJob(
  db: D1Database,
  kind: JobKind,
  logicalTimeUtc: string,
  status: 'completed' | 'failed' | 'cooldown' | 'deferred',
  error: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs
       SET status = ?1, completed_at_utc = ?2, error = ?3
       WHERE id = ?4`,
    )
    .bind(status, new Date().toISOString(), error, `${kind}:${logicalTimeUtc}`)
    .run();
}

async function rows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

const D1_JSON_PAYLOAD_MAX_BYTES = 180_000;

function jsonPayloadChunks<T>(values: T[]): string[] {
  if (!values.length) return [];
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let parts: string[] = [];
  let byteLength = 2;

  values.forEach((value) => {
    const serialized = JSON.stringify(value);
    const serializedBytes = encoder.encode(serialized).byteLength;
    if (serializedBytes + 2 > D1_JSON_PAYLOAD_MAX_BYTES) {
      throw new Error('Single D1 JSON row exceeds the safe payload limit');
    }
    const separatorBytes = parts.length ? 1 : 0;
    if (
      parts.length &&
      byteLength + separatorBytes + serializedBytes > D1_JSON_PAYLOAD_MAX_BYTES
    ) {
      chunks.push(`[${parts.join(',')}]`);
      parts = [];
      byteLength = 2;
    }
    parts.push(serialized);
    byteLength += (parts.length > 1 ? 1 : 0) + serializedBytes;
  });
  if (parts.length) chunks.push(`[${parts.join(',')}]`);
  return chunks;
}

async function loadPreviousState(db: D1Database, logicalHour: string) {
  const previousHour = new Date(
    Date.parse(logicalHour) - 3_600_000,
  ).toISOString();
  const [observationRows, authorRows, rankRows] = await Promise.all([
    rows<{
      post_id: string;
      score: number;
      comments: number;
      observed_at_utc: string;
      best_listing_rank: number | null;
    }>(
      db
        .prepare(
          `SELECT post_id, score, comments, observed_at_utc, best_listing_rank
           FROM post_observations WHERE observed_hour_utc = ?1`,
        )
        .bind(previousHour),
    ),
    rows<{ author: string; influence_score: number }>(
      db.prepare('SELECT author, influence_score FROM author_metrics'),
    ),
    rows<{ post_id: string; rank: number }>(
      db
        .prepare(
          'SELECT post_id, rank FROM hourly_rankings WHERE logical_hour_utc = ?1',
        )
        .bind(previousHour),
    ),
  ]);
  return {
    observations: new Map<string, PreviousObservation>(
      observationRows.map((row) => [
        row.post_id,
        {
          score: row.score,
          comments: row.comments,
          observedAtUtc: row.observed_at_utc,
          bestListingRank: row.best_listing_rank,
        },
      ]),
    ),
    authors: new Map(
      authorRows.map((row) => [row.author, row.influence_score]),
    ),
    ranks: new Map(rankRows.map((row) => [row.post_id, row.rank])),
  };
}

async function loadActiveTrackers(
  db: D1Database,
  logicalHour: string,
): Promise<ActiveTracker[]> {
  const result = await rows<{
    id: string;
    post_id: string;
    started_at_utc: string;
    expires_at_utc: string;
  }>(
    db
      .prepare(
        `SELECT id, post_id, started_at_utc, expires_at_utc
       FROM tracking_episodes
       WHERE status = 'active'
         AND expires_at_utc > ?1
       ORDER BY started_at_utc ASC
       LIMIT ${MAX_TRACKED_POSTS}`,
      )
      .bind(logicalHour),
  );
  return result.map((row) => ({
    id: row.id,
    postId: row.post_id,
    startedAtUtc: row.started_at_utc,
    expiresAtUtc: row.expires_at_utc,
  }));
}

async function loadExistingPosts(
  db: D1Database,
  ids: string[],
): Promise<Map<string, ExistingPost>> {
  if (!ids.length) return new Map();
  const uniqueIds = Array.from(new Set(ids));
  const result = (
    await Promise.all(
      chunksForD1(uniqueIds).map((chunk) => {
        const placeholders = chunk.map((_, index) => `?${index + 1}`).join(',');
        return rows<{
          id: string;
          content_hash: string;
          analysis_status: string;
        }>(
          db
            .prepare(
              `SELECT id, content_hash, analysis_status
               FROM reddit_posts WHERE id IN (${placeholders})`,
            )
            .bind(...chunk),
        );
      }),
    )
  ).flat();
  return new Map(
    result.map((row) => [
      row.id,
      {
        id: row.id,
        contentHash: row.content_hash,
        analysisStatus: row.analysis_status,
      },
    ]),
  );
}

function postUpserts(
  db: D1Database,
  candidates: RedditCandidate[],
  observedAt: string,
): D1PreparedStatement[] {
  const payloads = jsonPayloadChunks(
    candidates.map((candidate) => ({
      id: candidate.id,
      redditId: candidate.redditId,
      subreddit: candidate.subreddit,
      author: candidate.author,
      permalink: candidate.permalink,
      outboundUrl: candidate.outboundUrl,
      title: candidate.title,
      body: candidate.body,
      contentHash: candidate.contentHash ?? '',
      createdAtUtc: candidate.createdAtUtc,
      sourceProvider: candidate.sourceProvider ?? 'reddit',
      indexedAtUtc: candidate.indexedAtUtc ?? null,
    })),
  );
  return payloads.map((payload) =>
    db
      .prepare(
        `INSERT INTO reddit_posts (
         id, reddit_id, subreddit, author, permalink, outbound_url,
         title_original, body_original, content_hash, analysis_status,
         source_platform, created_at_utc, first_seen_at_utc, last_seen_at_utc, source_provider, indexed_at_utc
       )
       SELECT
         json_extract(input.value, '$.id'),
         json_extract(input.value, '$.redditId'),
         json_extract(input.value, '$.subreddit'),
         json_extract(input.value, '$.author'),
         json_extract(input.value, '$.permalink'),
         json_extract(input.value, '$.outboundUrl'),
         json_extract(input.value, '$.title'),
         json_extract(input.value, '$.body'),
         json_extract(input.value, '$.contentHash'),
         'pending',
         'reddit',
         json_extract(input.value, '$.createdAtUtc'),
         ?2,
         ?2,
         json_extract(input.value, '$.sourceProvider'),
         json_extract(input.value, '$.indexedAtUtc')
       FROM json_each(?1) AS input
       WHERE true
       ON CONFLICT(id) DO UPDATE SET
         subreddit = excluded.subreddit,
         author = excluded.author,
         permalink = excluded.permalink,
         outbound_url = excluded.outbound_url,
         title_original = excluded.title_original,
         body_original = excluded.body_original,
         analysis_status = CASE
           WHEN reddit_posts.content_hash <> excluded.content_hash THEN 'pending'
           ELSE reddit_posts.analysis_status
         END,
         content_hash = excluded.content_hash,
         source_provider = excluded.source_provider,
         indexed_at_utc = excluded.indexed_at_utc,
         last_seen_at_utc = excluded.last_seen_at_utc,
         deleted_at_utc = NULL
       WHERE reddit_posts.analysis_status <> 'deleted'`,
      )
      .bind(payload, observedAt),
  );
}

function observationUpserts(
  db: D1Database,
  candidates: ScoredCandidate[],
  logicalHour: string,
  observedAt: string,
): D1PreparedStatement[] {
  const payloads = jsonPayloadChunks(
    candidates.map((candidate) => ({
      id: candidate.id,
      score: candidate.score,
      comments: candidate.comments,
      upvoteRatio: candidate.upvoteRatio,
      metricsAvailable: candidate.metricsAvailable ? 1 : 0,
      bestListingRank: candidate.bestListingRank,
      velocityScore: candidate.velocityScore,
      heatScore: candidate.heatScore,
      discussionCount: candidate.discussionCount ?? 0,
    })),
  );
  return payloads.map((payload) =>
    db
      .prepare(
        `INSERT INTO post_observations (
         post_id, observed_hour_utc, observed_at_utc, score, comments,
         upvote_ratio, metrics_available, best_listing_rank, velocity_score, heat_score, discussion_count
       )
       SELECT
         json_extract(input.value, '$.id'),
         ?2,
         ?3,
         json_extract(input.value, '$.score'),
         json_extract(input.value, '$.comments'),
         json_extract(input.value, '$.upvoteRatio'),
         json_extract(input.value, '$.metricsAvailable'),
         json_extract(input.value, '$.bestListingRank'),
         json_extract(input.value, '$.velocityScore'),
         json_extract(input.value, '$.heatScore'),
         json_extract(input.value, '$.discussionCount')
       FROM json_each(?1) AS input
       WHERE true
       ON CONFLICT(post_id, observed_hour_utc) DO UPDATE SET
         observed_at_utc = excluded.observed_at_utc,
         score = excluded.score,
         comments = excluded.comments,
         upvote_ratio = excluded.upvote_ratio,
         metrics_available = excluded.metrics_available,
         best_listing_rank = excluded.best_listing_rank,
         velocity_score = excluded.velocity_score,
         heat_score = excluded.heat_score,
         discussion_count = excluded.discussion_count`,
      )
      .bind(payload, logicalHour, observedAt),
  );
}

async function analyzeSelected(
  env: CollectorEnv,
  selected: ScoredCandidate[],
  existing: Map<string, ExistingPost>,
): Promise<void> {
  if (!hasLlmProvider(env)) return;
  const targets = selected.filter((candidate) => {
    const prior = existing.get(candidate.id);
    return (
      !prior ||
      prior.contentHash !== candidate.contentHash ||
      prior.analysisStatus !== 'completed'
    );
  });
  const completed: Array<{
    id: string;
    contentHash: string;
    titleZh: string;
    translationZh: string;
    summaryZh: string;
    highlightsJson: string;
    topicsJson: string;
  }> = [];
  const failed: Array<{ id: string; contentHash: string }> = [];
  for (let index = 0; index < targets.length; index += 2) {
    const slice = targets.slice(index, index + 2);
    await Promise.all(
      slice.map(async (candidate) => {
        try {
          const analysis = await analyzePost(env, candidate);
          if (!analysis) return;
          completed.push({
            id: candidate.id,
            contentHash: candidate.contentHash ?? '',
            titleZh: analysis.titleZh,
            translationZh: analysis.translationZh,
            summaryZh: analysis.summaryZh,
            highlightsJson: JSON.stringify(analysis.highlights),
            topicsJson: JSON.stringify(analysis.topics),
          });
        } catch {
          failed.push({
            id: candidate.id,
            contentHash: candidate.contentHash ?? '',
          });
        }
      }),
    );
  }

  const statements: D1PreparedStatement[] = [];
  jsonPayloadChunks(completed).forEach((payload) => {
    statements.push(
      env.DB.prepare(
        `WITH updates AS (
           SELECT
             json_extract(input.value, '$.id') AS id,
             json_extract(input.value, '$.contentHash') AS content_hash,
             json_extract(input.value, '$.titleZh') AS title_zh,
             json_extract(input.value, '$.translationZh') AS translation_zh,
             json_extract(input.value, '$.summaryZh') AS summary_zh,
             json_extract(input.value, '$.highlightsJson') AS highlights_json,
             json_extract(input.value, '$.topicsJson') AS topics_json
           FROM json_each(?1) AS input
         )
         UPDATE reddit_posts SET
           title_zh = (SELECT title_zh FROM updates WHERE updates.id = reddit_posts.id),
           translation_zh = (SELECT translation_zh FROM updates WHERE updates.id = reddit_posts.id),
           summary_zh = (SELECT summary_zh FROM updates WHERE updates.id = reddit_posts.id),
           highlights_json = (SELECT highlights_json FROM updates WHERE updates.id = reddit_posts.id),
           topics_json = (SELECT topics_json FROM updates WHERE updates.id = reddit_posts.id),
           analysis_status = 'completed'
         WHERE EXISTS (
           SELECT 1 FROM updates
           WHERE updates.id = reddit_posts.id
             AND updates.content_hash = reddit_posts.content_hash
         )`,
      ).bind(payload),
    );
  });
  jsonPayloadChunks(failed).forEach((payload) => {
    statements.push(
      env.DB.prepare(
        `WITH failures AS (
           SELECT
             json_extract(input.value, '$.id') AS id,
             json_extract(input.value, '$.contentHash') AS content_hash
           FROM json_each(?1) AS input
         )
         UPDATE reddit_posts SET analysis_status = 'failed'
         WHERE EXISTS (
           SELECT 1 FROM failures
           WHERE failures.id = reddit_posts.id
             AND failures.content_hash = reddit_posts.content_hash
         )`,
      ).bind(payload),
    );
  });
  if (statements.length) await env.DB.batch(statements);
}

function authorObservationUpserts(
  db: D1Database,
  candidates: ScoredCandidate[],
  selected: ScoredCandidate[],
  logicalHour: string,
): D1PreparedStatement[] {
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const values = candidates.filter(
    (candidate): candidate is ScoredCandidate & { author: string } =>
      Boolean(candidate.author),
  );
  const payloads = jsonPayloadChunks(
    values.map((candidate) => ({
      author: candidate.author,
      postId: candidate.id,
      subreddit: candidate.subreddit,
      peakHeatScore: candidate.heatScore,
      isTopHit: selectedIds.has(candidate.id) ? 1 : 0,
    })),
  );
  return payloads.map((payload) =>
    db
      .prepare(
        `INSERT INTO author_observations
          (author, post_id, first_seen_at_utc, subreddit, peak_heat_score, is_top_hit)
         SELECT
           json_extract(input.value, '$.author'),
           json_extract(input.value, '$.postId'),
           ?2,
           json_extract(input.value, '$.subreddit'),
           json_extract(input.value, '$.peakHeatScore'),
           json_extract(input.value, '$.isTopHit')
         FROM json_each(?1) AS input
         WHERE true
         ON CONFLICT(author, post_id) DO UPDATE SET
           subreddit = excluded.subreddit,
           peak_heat_score = MAX(author_observations.peak_heat_score, excluded.peak_heat_score),
           is_top_hit = MAX(author_observations.is_top_hit, excluded.is_top_hit)`,
      )
      .bind(payload, logicalHour),
  );
}

async function purgeExpiredUserContent(
  db: D1Database,
  referenceMs: number,
  retentionHours: number,
): Promise<void> {
  const cutoff = new Date(
    referenceMs - retentionHours * 3_600_000,
  ).toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE reddit_posts SET
           author = NULL,
           outbound_url = NULL,
           permalink = 'expired:' || id,
           title_original = '[content expired]',
           body_original = '',
           title_zh = NULL,
           translation_zh = NULL,
           summary_zh = NULL,
           highlights_json = '[]',
           topics_json = '[]',
           content_hash = '',
           analysis_status = 'expired'
         WHERE first_seen_at_utc <= ?1
           AND analysis_status NOT IN ('expired', 'deleted')`,
      )
      .bind(cutoff),
    db
      .prepare('DELETE FROM author_observations WHERE first_seen_at_utc <= ?1')
      .bind(cutoff),
    db.prepare(
      `DELETE FROM author_metrics
       WHERE author NOT IN (SELECT DISTINCT author FROM author_observations)`,
    ),
  ]);
}

async function refreshAuthorMetrics(
  db: D1Database,
  now: string,
  retentionHours: number,
): Promise<void> {
  const cutoff = new Date(
    Date.parse(now) - retentionHours * 3_600_000,
  ).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO author_metrics
          (author, influence_score, observed_posts, top_hit_rate, subreddit_count, computed_at_utc)
         SELECT
           stats.author,
           ROUND(
             (
               0.5 +
               (
                 (
                   0.5 * MIN(1.0, MAX(0.0, stats.avg_heat / 100.0)) +
                   0.3 * ((stats.top_hits + 1.0) / (stats.observed_posts + 4.0)) +
                   0.2 * MIN(1.0, stats.subreddit_count / 4.0)
                 ) - 0.5
               ) * MIN(1.0, stats.observed_posts / 12.0)
             ) * 1000.0
           ) / 1000.0,
           stats.observed_posts,
           (stats.top_hits + 1.0) / (stats.observed_posts + 4.0),
           stats.subreddit_count,
           ?2
         FROM (
           SELECT author,
                  COUNT(DISTINCT post_id) AS observed_posts,
                  COUNT(DISTINCT CASE WHEN is_top_hit = 1 THEN post_id END) AS top_hits,
                  AVG(peak_heat_score) AS avg_heat,
                  COUNT(DISTINCT subreddit) AS subreddit_count
           FROM author_observations
           WHERE first_seen_at_utc > ?1
           GROUP BY author
         ) AS stats
         WHERE true
         ON CONFLICT(author) DO UPDATE SET
           influence_score = excluded.influence_score,
           observed_posts = excluded.observed_posts,
           top_hit_rate = excluded.top_hit_rate,
           subreddit_count = excluded.subreddit_count,
           computed_at_utc = excluded.computed_at_utc
         WHERE author_metrics.influence_score <> excluded.influence_score
            OR author_metrics.observed_posts <> excluded.observed_posts
            OR author_metrics.top_hit_rate <> excluded.top_hit_rate
            OR author_metrics.subreddit_count <> excluded.subreddit_count`,
      )
      .bind(cutoff, now),
    db
      .prepare(
        `DELETE FROM author_metrics
         WHERE author NOT IN (
           SELECT DISTINCT author FROM author_observations WHERE first_seen_at_utc > ?1
         )`,
      )
      .bind(cutoff),
  ]);
}

export async function runHourly(
  env: CollectorEnv,
  scheduledAtMs: number,
): Promise<JobResult> {
  const logicalHour = logicalHourIso(scheduledAtMs);
  const sourceMode = redditSourceMode(env);
  const retentionHours = clampRawRetentionHours(
    env.RAW_CONTENT_RETENTION_HOURS,
  );
  if (!(await acquireJob(env.DB, 'hourly', logicalHour, sourceMode))) {
    return { status: 'skipped', kind: 'hourly', logicalTimeUtc: logicalHour };
  }
  const observedAt = new Date().toISOString();
  let stage: RunStage = 'preparing';
  const setStage = async (next: RunStage) => {
    stage = next;
    await env.DB.prepare(
      'UPDATE hourly_runs SET stage = ?1 WHERE logical_hour_utc = ?2',
    )
      .bind(next, logicalHour)
      .run();
  };

  try {
    await env.DB.prepare(
      `INSERT INTO hourly_runs
          (logical_hour_utc, started_at_utc, status, source_mode, candidate_count, selected_count, stage)
         VALUES (?1, ?2, 'running', ?3, 0, 0, 'preparing')
         ON CONFLICT(logical_hour_utc) DO UPDATE SET
           started_at_utc = excluded.started_at_utc,
           completed_at_utc = NULL,
           status = 'running',
           source_mode = excluded.source_mode,
           error = NULL, stage = 'preparing', upstream_status = NULL, retry_at_utc = NULL,
           candidate_count = 0, selected_count = 0`,
    )
      .bind(logicalHour, observedAt, sourceMode)
      .run();

    await purgeExpiredUserContent(env.DB, Date.now(), retentionHours);

    await setStage('source');
    const session = await createRedditSession(env);
    const [trackers, previousState] = await Promise.all([
      loadActiveTrackers(env.DB, logicalHour),
      loadPreviousState(env.DB, logicalHour),
    ]);
    const collect = async () => {
      const discovered = await discoverRedditCandidates(env, session);
      const trackedRaw =
        session.mode !== 'rss-preview' && trackers.length
          ? await refreshTrackedPosts(
              env,
              trackers.map((tracker) => tracker.postId),
              session,
            )
          : [];
      return { discovered, trackedRaw };
    };
    const { discovered, trackedRaw } =
      session.mode !== 'oauth'
        ? await withRssCooldown(
            env.DB,
            collect,
            Date.now,
            session.mode === 'arctic-shift' ? 'arctic-shift' : 'reddit-rss',
          )
        : await collect();
    await env.DB.prepare(
      'UPDATE hourly_runs SET source_details_json = ?1 WHERE logical_hour_utc = ?2',
    )
      .bind(JSON.stringify(session.sourceDetails ?? {}), logicalHour)
      .run();
    await setStage('ranking');
    const keywords = parseCsv(env.ETF_KEYWORDS, DEFAULT_ETF_KEYWORDS);
    const merged = new Map(
      discovered.map((candidate) => [candidate.id, candidate]),
    );
    const invalidTrackedIds = new Set(
      session.mode === 'oauth' ? trackers.map((tracker) => tracker.postId) : [],
    );
    discovered.forEach((candidate) => invalidTrackedIds.delete(candidate.id));
    trackedRaw.forEach((child) => {
      const candidate =
        session.mode === 'arctic-shift'
          ? normalizeIndexedPost(child.data ?? {}, keywords)
          : normalizeRedditPost(child, 'tracked', 50, keywords);
      const rawId =
        typeof child.data?.id === 'string' || typeof child.data?.id === 'number'
          ? `t3_${String(child.data.id).toLowerCase()}`
          : null;
      if (candidate) {
        if (session.mode === 'arctic-shift')
          candidate.discussionCount =
            session.commentCounts?.get(candidate.id) ?? 0;
        if (session.mode === 'arctic-shift' && merged.has(candidate.id)) return;
        if (rawId) invalidTrackedIds.delete(rawId);
        merged.set(
          candidate.id,
          mergeCandidate(merged.get(candidate.id), candidate),
        );
      } else if (session.mode === 'arctic-shift' && rawId) {
        invalidTrackedIds.add(rawId);
        merged.delete(rawId);
      }
    });

    const deletedPosts = await rows<{ id: string }>(
      env.DB.prepare(
        "SELECT id FROM reddit_posts WHERE analysis_status = 'deleted'",
      ),
    );
    deletedPosts.forEach((post) => merged.delete(post.id));
    const scored = scoreCandidates(
      [...merged.values()],
      scheduledAtMs,
      previousState.observations,
      previousState.authors,
      previousState.ranks,
    );
    const newTrackingCutoff = scheduledAtMs - 24 * 60 * 60 * 1_000;
    const selectableDiscoveredIds = new Set(
      discovered
        .filter(
          (candidate) =>
            Date.parse(candidate.createdAtUtc) >= newTrackingCutoff,
        )
        .map((candidate) => candidate.id),
    );
    const selected = selectTopStories(
      scored.filter((candidate) => selectableDiscoveredIds.has(candidate.id)),
    );
    const persistIds = new Set([
      ...selected.map((candidate) => candidate.id),
      ...trackers.map((tracker) => tracker.postId),
    ]);
    const persisted = scored.filter((candidate) =>
      persistIds.has(candidate.id),
    );
    await Promise.all(
      persisted.map(async (candidate) => {
        candidate.contentHash = await sha256Hex(
          `${candidate.title}\n${candidate.body}`,
        );
      }),
    );
    const existing = await loadExistingPosts(
      env.DB,
      persisted.map((candidate) => candidate.id),
    );

    const statements: D1PreparedStatement[] = [
      ...postUpserts(env.DB, persisted, observedAt),
      ...observationUpserts(env.DB, persisted, logicalHour, observedAt),
    ];
    statements.push(
      ...authorObservationUpserts(
        env.DB,
        scored.filter((candidate) => selectableDiscoveredIds.has(candidate.id)),
        selected,
        logicalHour,
      ),
    );
    if (invalidTrackedIds.size) {
      const invalidPayload = JSON.stringify([...invalidTrackedIds]);
      statements.push(
        env.DB.prepare(
          `DELETE FROM author_observations
             WHERE post_id IN (SELECT value FROM json_each(?1))`,
        ).bind(invalidPayload),
      );
      statements.push(
        env.DB.prepare(
          `UPDATE reddit_posts SET
               author = NULL,
               permalink = 'deleted:' || id,
               outbound_url = NULL,
               title_original = '[deleted]',
               body_original = '',
               title_zh = NULL,
               translation_zh = NULL,
               summary_zh = NULL,
               highlights_json = '[]',
               topics_json = '[]',
               content_hash = '',
               analysis_status = 'deleted',
               deleted_at_utc = ?1,
               last_seen_at_utc = ?1
             WHERE id IN (SELECT value FROM json_each(?2))`,
        ).bind(observedAt, invalidPayload),
      );
    }

    statements.push(
      env.DB.prepare(
        "UPDATE tracking_episodes SET status = 'completed' WHERE status = 'active' AND expires_at_utc <= ?1",
      ).bind(logicalHour),
    );

    const activeByPost = new Map(
      trackers
        .filter((tracker) => tracker.expiresAtUtc > logicalHour)
        .map((tracker) => [tracker.postId, tracker]),
    );
    let activeCount = activeByPost.size;
    const activeTrackerIds: string[] = [];
    const newTrackers: Array<{
      id: string;
      postId: string;
      expiresAtUtc: string;
    }> = [];
    selected.forEach((candidate) => {
      const active = activeByPost.get(candidate.id);
      if (active) {
        activeTrackerIds.push(active.id);
      } else if (activeCount < MAX_TRACKED_POSTS) {
        const expires = new Date(
          Date.parse(logicalHour) + 24 * 60 * 60 * 1_000,
        ).toISOString();
        newTrackers.push({
          id: `${candidate.id}:${logicalHour}`,
          postId: candidate.id,
          expiresAtUtc: expires,
        });
        activeCount += 1;
      }
    });
    if (activeTrackerIds.length) {
      statements.push(
        env.DB.prepare(
          `UPDATE tracking_episodes
             SET selected_count = CASE
                   WHEN last_selected_at_utc <> ?1 THEN selected_count + 1
                   ELSE selected_count
                 END,
                 last_selected_at_utc = ?1
             WHERE id IN (SELECT value FROM json_each(?2))`,
        ).bind(logicalHour, JSON.stringify(activeTrackerIds)),
      );
    }
    jsonPayloadChunks(newTrackers).forEach((payload) => {
      statements.push(
        env.DB.prepare(
          `INSERT INTO tracking_episodes
              (id, post_id, started_at_utc, expires_at_utc, last_selected_at_utc, selected_count, status)
           SELECT
             json_extract(input.value, '$.id'),
             json_extract(input.value, '$.postId'),
             ?2,
             json_extract(input.value, '$.expiresAtUtc'),
             ?2,
             1,
             'active'
           FROM json_each(?1) AS input
           WHERE true
           ON CONFLICT(id) DO NOTHING`,
        ).bind(payload, logicalHour),
      );
    });

    statements.push(
      env.DB.prepare(
        'DELETE FROM hourly_rankings WHERE logical_hour_utc = ?1',
      ).bind(logicalHour),
    );
    jsonPayloadChunks(
      selected.map((candidate, index) => ({
        rank: index + 1,
        postId: candidate.id,
        heatScore: candidate.heatScore,
        componentsJson: JSON.stringify(candidate.components),
        previousRank: candidate.previousRank,
      })),
    ).forEach((payload) => {
      statements.push(
        env.DB.prepare(
          `INSERT INTO hourly_rankings
              (logical_hour_utc, rank, post_id, heat_score, components_json, previous_rank)
           SELECT
             ?2,
             json_extract(input.value, '$.rank'),
             json_extract(input.value, '$.postId'),
             json_extract(input.value, '$.heatScore'),
             json_extract(input.value, '$.componentsJson'),
             json_extract(input.value, '$.previousRank')
           FROM json_each(?1) AS input`,
        ).bind(payload, logicalHour),
      );
    });
    await setStage('persistence');
    if (statements.length) await env.DB.batch(statements);
    await env.DB.prepare(
      'UPDATE hourly_runs SET candidate_count = ?1, selected_count = ?2 WHERE logical_hour_utc = ?3',
    )
      .bind(discovered.length, selected.length, logicalHour)
      .run();
    await setStage('analysis');
    await analyzeSelected(env, selected, existing);
    await setStage('publishing');
    await refreshAuthorMetrics(env.DB, observedAt, retentionHours);
    await finishJob(env.DB, 'hourly', logicalHour, 'completed');
    await env.DB.prepare(
      `UPDATE hourly_runs SET completed_at_utc = ?1, status = 'completed', stage = 'completed',
         error = NULL, upstream_status = NULL, retry_at_utc = NULL WHERE logical_hour_utc = ?2`,
    )
      .bind(new Date().toISOString(), logicalHour)
      .run();
    return {
      status: 'completed',
      kind: 'hourly',
      logicalTimeUtc: logicalHour,
      selected: selected.length,
      candidates: discovered.length,
      sourceMode,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof RssDeferredError) {
      const status = error.reason === 'rate_limited' ? 'cooldown' : 'deferred';
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE hourly_runs SET status = ?1, completed_at_utc = ?2, error = ?3,
             stage = 'source', upstream_status = ?4, retry_at_utc = ?5 WHERE logical_hour_utc = ?6`,
        ).bind(
          status,
          new Date().toISOString(),
          message,
          status === 'cooldown' ? 429 : null,
          error.retryAtUtc,
          logicalHour,
        ),
        env.DB.prepare(
          'UPDATE job_runs SET status = ?1, completed_at_utc = ?2, error = ?3 WHERE id = ?4',
        ).bind(
          status,
          new Date().toISOString(),
          message,
          `hourly:${logicalHour}`,
        ),
      ]);
      return {
        status,
        kind: 'hourly',
        logicalTimeUtc: logicalHour,
        sourceMode,
        retryAtUtc: error.retryAtUtc,
        reason: error.reason,
        ...(status === 'cooldown' ? { upstreamStatus: 429 } : {}),
      };
    }
    await Promise.allSettled([
      finishJob(env.DB, 'hourly', logicalHour, 'failed', message),
      env.DB.prepare(
        `UPDATE hourly_runs SET status = 'failed', completed_at_utc = ?1, error = ?2,
           stage = ?4, upstream_status = ?5 WHERE logical_hour_utc = ?3`,
      )
        .bind(
          new Date().toISOString(),
          message,
          logicalHour,
          stage,
          error instanceof RedditRssError ? (error.status ?? null) : null,
        )
        .run(),
    ]);
    throw error;
  }
}

function deidentifiedReport(
  value: ReportAnalysis | null,
): ReportAnalysis | null {
  if (!value) return null;
  if (
    containsRedditUserHandle(value.headline) ||
    containsRedditUserHandle(value.executiveSummary)
  ) {
    return null;
  }
  return {
    ...value,
    themes: value.themes.filter((theme) => !containsRedditUserHandle(theme)),
  };
}

function reportSource(
  env: CollectorEnv,
): 'reddit_rss_preview' | 'reddit_oauth' | 'reddit_arctic_shift' {
  if (redditSourceMode(env) === 'arctic-shift') return 'reddit_arctic_shift';
  return redditSourceMode(env) === 'rss-preview'
    ? 'reddit_rss_preview'
    : 'reddit_oauth';
}

async function optionalReportAnalysis(
  env: CollectorEnv,
  kind: 'daily' | 'weekly',
  facts: unknown,
): Promise<ReportAnalysis | null> {
  try {
    return deidentifiedReport(await summarizeReport(env, kind, facts));
  } catch {
    return null;
  } // Archive factual aggregates even when the free AI quota or service is unavailable.
}

async function topTopicSignalsForWindow(
  db: D1Database,
  startUtc: string,
  endUtc: string,
) {
  return rows<{
    topics_json: string;
    author: string | null;
    peak_heat: number;
    appearances: number;
    peak_rank: number;
  }>(
    db
      .prepare(
        `SELECT p.topics_json,
                p.author,
                MAX(hr.heat_score) AS peak_heat,
                COUNT(*) AS appearances,
                MIN(hr.rank) AS peak_rank
         FROM hourly_rankings hr
         JOIN reddit_posts p ON p.id = hr.post_id
         JOIN hourly_runs run ON run.logical_hour_utc = hr.logical_hour_utc AND run.status = 'completed'
         WHERE hr.logical_hour_utc >= ?1 AND hr.logical_hour_utc < ?2
           AND p.analysis_status NOT IN ('deleted', 'expired')
         GROUP BY p.id
         ORDER BY peak_heat DESC, appearances DESC, p.id ASC
         LIMIT 120`,
      )
      .bind(startUtc, endUtc),
  );
}

export async function runDaily(
  env: CollectorEnv,
  scheduledAtMs: number,
): Promise<JobResult> {
  const window = previousBeijingDayWindow(scheduledAtMs);
  const logicalTime = window.endUtc;
  if (!(await acquireJob(env.DB, 'daily', logicalTime))) {
    return {
      status: 'skipped',
      kind: 'daily',
      logicalTimeUtc: logicalTime,
      reportLabel: window.label,
    };
  }
  try {
    const [topicSignals, coverageRows] = await Promise.all([
      topTopicSignalsForWindow(env.DB, window.startUtc, window.endUtc),
      rows<{ count: number }>(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM hourly_runs
             WHERE logical_hour_utc >= ?1 AND logical_hour_utc < ?2 AND status = 'completed'`,
        ).bind(window.startUtc, window.endUtc),
      ),
    ]);
    const coverage = Number(coverageRows[0]?.count ?? 0);
    const topicCounts = new Map<string, number>();
    topicSignals.forEach((signal) => {
      safeReportTopicLabels(signal.topics_json, [signal.author]).forEach(
        (topic) => {
          topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
        },
      );
    });
    const topTopics = [...topicCounts.entries()]
      .sort(([leftTopic, leftCount], [rightTopic, rightCount]) =>
        rightCount === leftCount
          ? leftTopic.localeCompare(rightTopic)
          : rightCount - leftCount,
      )
      .slice(0, 20)
      .map(([topic, storyCount]) => ({ topic, storyCount }));
    const peakHeat = Math.max(
      0,
      ...topicSignals.map((signal) => Number(signal.peak_heat)),
    );
    const facts = {
      source: reportSource(env),
      reportDate: window.label,
      coverage: `${coverage}/24`,
      topTopics,
      metrics: { topStoryCount: topicSignals.length, peakHeat },
    };
    const generated = topTopics.length
      ? await optionalReportAnalysis(env, 'daily', facts)
      : null;
    const headline =
      generated?.headline || `${window.label} Reddit ETF 热门话题日报`;
    const executiveSummary =
      generated?.executiveSummary ||
      (topicSignals.length
        ? `今日共整理 ${topicSignals.length} 个入榜 ETF 话题，完整度 ${coverage}/24。`
        : `本日暂无足够数据生成话题摘要，完整度 ${coverage}/24。`);
    const sections = {
      analysisStatus: generated ? 'ai' : 'aggregate',
      themes: generated?.themes.length
        ? generated.themes
        : topTopics.slice(0, 8).map(({ topic }) => topic),
      metrics: {
        topStoryCount: topicSignals.length,
        peakHeat,
      },
      missingHours: Math.max(0, 24 - coverage),
      source: reportSource(env),
      privacyVersion: 2,
    };
    await env.DB.prepare(
      `INSERT INTO daily_reports (
           report_date, period_start_utc, period_end_utc, generated_at_utc,
           headline, executive_summary, sections_json, coverage_success, coverage_expected, version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 24, 1)
         ON CONFLICT(report_date) DO UPDATE SET
           generated_at_utc = excluded.generated_at_utc,
           headline = excluded.headline,
           executive_summary = excluded.executive_summary,
           sections_json = excluded.sections_json,
           coverage_success = excluded.coverage_success,
           version = daily_reports.version + 1`,
    )
      .bind(
        window.label,
        window.startUtc,
        window.endUtc,
        new Date().toISOString(),
        headline,
        executiveSummary,
        JSON.stringify(sections),
        coverage,
      )
      .run();

    await purgeExpiredUserContent(
      env.DB,
      Date.now(),
      clampRawRetentionHours(env.RAW_CONTENT_RETENTION_HOURS),
    );

    await finishJob(env.DB, 'daily', logicalTime, 'completed');
    return {
      status: 'completed',
      kind: 'daily',
      logicalTimeUtc: logicalTime,
      reportLabel: window.label,
    };
  } catch (error) {
    await finishJob(
      env.DB,
      'daily',
      logicalTime,
      'failed',
      errorMessage(error),
    );
    throw error;
  }
}

export async function runWeekly(
  env: CollectorEnv,
  scheduledAtMs: number,
): Promise<JobResult> {
  const window = previousBeijingWeekWindow(scheduledAtMs);
  const logicalTime = window.endUtc;
  if (!(await acquireJob(env.DB, 'weekly', logicalTime))) {
    return {
      status: 'skipped',
      kind: 'weekly',
      logicalTimeUtc: logicalTime,
      reportLabel: window.label,
    };
  }
  try {
    const [dailyRows, activityRows] = await Promise.all([
      rows<{
        report_date: string;
        coverage_success: number;
        sections_json: string;
      }>(
        env.DB.prepare(
          `SELECT report_date, coverage_success, sections_json
             FROM daily_reports
             WHERE period_start_utc >= ?1 AND period_end_utc <= ?2
             ORDER BY report_date ASC`,
        ).bind(window.startUtc, window.endUtc),
      ),
      rows<{
        unique_posts: number;
        rank_slots: number;
        peak_heat: number | null;
      }>(
        env.DB.prepare(
          `SELECT COUNT(DISTINCT post_id) AS unique_posts,
                    COUNT(*) AS rank_slots,
                    MAX(heat_score) AS peak_heat
             FROM hourly_rankings ranking
             JOIN hourly_runs run ON run.logical_hour_utc = ranking.logical_hour_utc AND run.status = 'completed'
             WHERE ranking.logical_hour_utc >= ?1 AND ranking.logical_hour_utc < ?2`,
        ).bind(window.startUtc, window.endUtc),
      ),
    ]);
    const daily = dailyRows.map((row) => {
      let themes: string[] = [];
      try {
        const parsed = JSON.parse(row.sections_json) as { themes?: unknown };
        if (Array.isArray(parsed.themes)) {
          themes = parsed.themes
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.replace(/\s+/g, ' ').trim().slice(0, 40))
            .filter(
              (value) => value.length > 1 && !containsRedditUserHandle(value),
            );
        }
      } catch {
        themes = [];
      }
      return {
        reportDate: row.report_date,
        coverageSuccess: row.coverage_success,
        themes,
      };
    });
    const activity = activityRows[0] ?? {
      unique_posts: 0,
      rank_slots: 0,
      peak_heat: null,
    };
    const weeklyThemes = [
      ...new Set(daily.flatMap((report) => report.themes)),
    ].slice(0, 8);
    const facts = {
      source: reportSource(env),
      weekStart: window.label,
      daysIncluded: daily.length,
      daily: daily.map((report) => ({
        ...report,
        themes: report.themes.slice(0, 6).map((theme) => theme.slice(0, 20)),
      })),
      activity,
    };
    const generated = daily.some((report) => report.themes.length)
      ? await optionalReportAnalysis(env, 'weekly', facts)
      : null;
    const headline = generated?.headline || `ETF 热门话题周报｜${window.label}`;
    const executiveSummary =
      generated?.executiveSummary ||
      `本周汇总 ${daily.length} 份 Reddit ETF 日报与 ${Number(activity.unique_posts)} 个入榜话题。`;
    const sections = {
      analysisStatus: generated ? 'ai' : 'aggregate',
      themes: generated?.themes.length ? generated.themes : weeklyThemes,
      dailyCoverage: daily.map((report) => ({
        reportDate: report.reportDate,
        coverageSuccess: report.coverageSuccess,
      })),
      metrics: {
        uniquePosts: Number(activity.unique_posts),
        rankSlots: Number(activity.rank_slots),
        peakHeat: Number(activity.peak_heat ?? 0),
      },
      source: reportSource(env),
      privacyVersion: 2,
    };
    await env.DB.prepare(
      `INSERT INTO weekly_reports (
           week_start_date, period_start_utc, period_end_utc, generated_at_utc,
           headline, executive_summary, sections_json, days_included, version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
         ON CONFLICT(week_start_date) DO UPDATE SET
           generated_at_utc = excluded.generated_at_utc,
           headline = excluded.headline,
           executive_summary = excluded.executive_summary,
           sections_json = excluded.sections_json,
           days_included = excluded.days_included,
           version = weekly_reports.version + 1`,
    )
      .bind(
        window.label,
        window.startUtc,
        window.endUtc,
        new Date().toISOString(),
        headline,
        executiveSummary,
        JSON.stringify(sections),
        daily.length,
      )
      .run();
    await purgeExpiredUserContent(
      env.DB,
      Date.now(),
      clampRawRetentionHours(env.RAW_CONTENT_RETENTION_HOURS),
    );
    await finishJob(env.DB, 'weekly', logicalTime, 'completed');
    return {
      status: 'completed',
      kind: 'weekly',
      logicalTimeUtc: logicalTime,
      reportLabel: window.label,
    };
  } catch (error) {
    await finishJob(
      env.DB,
      'weekly',
      logicalTime,
      'failed',
      errorMessage(error),
    );
    throw error;
  }
}

export async function runJob(
  env: CollectorEnv,
  kind: JobKind,
  scheduledAtMs: number,
): Promise<JobResult> {
  if (kind === 'hourly') return runHourly(env, scheduledAtMs);
  if (kind === 'daily') return runDaily(env, scheduledAtMs);
  return runWeekly(env, scheduledAtMs);
}
