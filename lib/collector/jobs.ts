import {
  DEFAULT_ETF_KEYWORDS,
  logicalHourIso,
  MAX_TRACKED_POSTS,
  mergeCandidate,
  normalizeRedditPost,
  parseCsv,
  previousBeijingDayWindow,
  previousBeijingWeekWindow,
  scoreCandidates,
  selectTopStories,
  sha256Hex,
  type PreviousObservation,
  type RedditCandidate,
  type ScoredCandidate,
} from './core';
import { analyzePost, summarizeReport, type LlmEnv } from './llm';
import {
  createRedditSession,
  discoverRedditCandidates,
  refreshTrackedPosts,
  type RedditEnv,
} from './reddit';

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
  status: 'completed' | 'skipped';
  kind: JobKind;
  logicalTimeUtc: string;
  selected?: number;
  candidates?: number;
  reportLabel?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

async function acquireJob(
  db: D1Database,
  kind: JobKind,
  logicalTimeUtc: string,
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
          OR (job_runs.status = 'running' AND job_runs.started_at_utc < ?5)`,
    )
    .bind(id, kind, logicalTimeUtc, now, stale)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function finishJob(
  db: D1Database,
  kind: JobKind,
  logicalTimeUtc: string,
  status: 'completed' | 'failed',
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

async function loadPreviousState(db: D1Database, logicalHour: string) {
  const previousHour = new Date(Date.parse(logicalHour) - 3_600_000).toISOString();
  const [observationRows, authorRows, rankRows] = await Promise.all([
    rows<{ post_id: string; score: number; comments: number; observed_at_utc: string }>(
      db
        .prepare(
          `SELECT post_id, score, comments, observed_at_utc
           FROM post_observations WHERE observed_hour_utc = ?1`,
        )
        .bind(previousHour),
    ),
    rows<{ author: string; influence_score: number }>(
      db.prepare('SELECT author, influence_score FROM author_metrics'),
    ),
    rows<{ post_id: string; rank: number }>(
      db
        .prepare('SELECT post_id, rank FROM hourly_rankings WHERE logical_hour_utc = ?1')
        .bind(previousHour),
    ),
  ]);
  return {
    observations: new Map<string, PreviousObservation>(
      observationRows.map((row) => [
        row.post_id,
        { score: row.score, comments: row.comments, observedAtUtc: row.observed_at_utc },
      ]),
    ),
    authors: new Map(authorRows.map((row) => [row.author, row.influence_score])),
    ranks: new Map(rankRows.map((row) => [row.post_id, row.rank])),
  };
}

async function loadActiveTrackers(db: D1Database): Promise<ActiveTracker[]> {
  const result = await rows<{
    id: string;
    post_id: string;
    started_at_utc: string;
    expires_at_utc: string;
  }>(
    db.prepare(
      `SELECT id, post_id, started_at_utc, expires_at_utc
       FROM tracking_episodes
       WHERE status = 'active'
       ORDER BY started_at_utc ASC
       LIMIT ${MAX_TRACKED_POSTS}`,
    ),
  );
  return result.map((row) => ({
    id: row.id,
    postId: row.post_id,
    startedAtUtc: row.started_at_utc,
    expiresAtUtc: row.expires_at_utc,
  }));
}

async function loadExistingPosts(db: D1Database, ids: string[]): Promise<Map<string, ExistingPost>> {
  if (!ids.length) return new Map();
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(',');
  const result = await rows<{
    id: string;
    content_hash: string;
    analysis_status: string;
  }>(
    db
      .prepare(
        `SELECT id, content_hash, analysis_status
         FROM reddit_posts WHERE id IN (${placeholders})`,
      )
      .bind(...ids),
  );
  return new Map(
    result.map((row) => [
      row.id,
      { id: row.id, contentHash: row.content_hash, analysisStatus: row.analysis_status },
    ]),
  );
}

function postUpsert(
  db: D1Database,
  candidate: RedditCandidate,
  observedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reddit_posts (
         id, reddit_id, subreddit, author, permalink, outbound_url,
         title_original, body_original, content_hash, analysis_status,
         source_platform, created_at_utc, first_seen_at_utc, last_seen_at_utc
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 'reddit', ?10, ?11, ?11)
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
         last_seen_at_utc = excluded.last_seen_at_utc,
         deleted_at_utc = NULL`,
    )
    .bind(
      candidate.id,
      candidate.redditId,
      candidate.subreddit,
      candidate.author,
      candidate.permalink,
      candidate.outboundUrl,
      candidate.title,
      candidate.body,
      candidate.contentHash ?? '',
      candidate.createdAtUtc,
      observedAt,
    );
}

function observationUpsert(
  db: D1Database,
  candidate: ScoredCandidate,
  logicalHour: string,
  observedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO post_observations (
         post_id, observed_hour_utc, observed_at_utc, score, comments,
         upvote_ratio, best_listing_rank, velocity_score, heat_score
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(post_id, observed_hour_utc) DO UPDATE SET
         observed_at_utc = excluded.observed_at_utc,
         score = excluded.score,
         comments = excluded.comments,
         upvote_ratio = excluded.upvote_ratio,
         best_listing_rank = excluded.best_listing_rank,
         velocity_score = excluded.velocity_score,
         heat_score = excluded.heat_score`,
    )
    .bind(
      candidate.id,
      logicalHour,
      observedAt,
      candidate.score,
      candidate.comments,
      candidate.upvoteRatio,
      candidate.bestListingRank,
      candidate.velocityScore,
      candidate.heatScore,
    );
}

async function analyzeSelected(
  env: CollectorEnv,
  selected: ScoredCandidate[],
  existing: Map<string, ExistingPost>,
): Promise<void> {
  if (!env.OPENAI_API_KEY) return;
  const targets = selected.filter((candidate) => {
    const prior = existing.get(candidate.id);
    return !prior || prior.contentHash !== candidate.contentHash || prior.analysisStatus !== 'completed';
  });
  for (let index = 0; index < targets.length; index += 2) {
    const slice = targets.slice(index, index + 2);
    await Promise.all(
      slice.map(async (candidate) => {
        try {
          const analysis = await analyzePost(env, candidate);
          if (!analysis) return;
          await env.DB
            .prepare(
              `UPDATE reddit_posts SET
                 title_zh = ?1,
                 translation_zh = ?2,
                 summary_zh = ?3,
                 highlights_json = ?4,
                 topics_json = ?5,
                 analysis_status = 'completed'
               WHERE id = ?6 AND content_hash = ?7`,
            )
            .bind(
              analysis.titleZh,
              analysis.translationZh,
              analysis.summaryZh,
              JSON.stringify(analysis.highlights),
              JSON.stringify(analysis.topics),
              candidate.id,
              candidate.contentHash,
            )
            .run();
        } catch {
          await env.DB
            .prepare("UPDATE reddit_posts SET analysis_status = 'failed' WHERE id = ?1")
            .bind(candidate.id)
            .run();
        }
      }),
    );
  }
}

async function refreshAuthorMetrics(db: D1Database, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - 90 * 24 * 60 * 60 * 1_000).toISOString();
  const authors = await rows<{
    author: string;
    observed_posts: number;
    top_hits: number;
    avg_heat: number;
    subreddit_count: number;
  }>(
    db.prepare(
      `SELECT p.author AS author,
              COUNT(DISTINCT p.id) AS observed_posts,
              COUNT(DISTINCT hr.post_id) AS top_hits,
              AVG(po.heat_score) AS avg_heat,
              COUNT(DISTINCT p.subreddit) AS subreddit_count
       FROM reddit_posts p
       LEFT JOIN post_observations po ON po.post_id = p.id
       LEFT JOIN hourly_rankings hr ON hr.post_id = p.id
       WHERE p.author IS NOT NULL
         AND p.last_seen_at_utc >= ?1
       GROUP BY p.author`,
    ).bind(cutoff),
  );
  if (!authors.length) return;
  const statements = authors.map((row) => {
    const hitRate = (row.top_hits + 1) / (row.observed_posts + 4);
    const average = Math.min(1, Math.max(0, Number(row.avg_heat ?? 50) / 100));
    const coverage = Math.min(1, Number(row.subreddit_count) / 4);
    const shrink = Math.min(1, Number(row.observed_posts) / 5);
    const raw = 0.5 * average + 0.3 * hitRate + 0.2 * coverage;
    const influence = 0.5 + (raw - 0.5) * shrink;
    return db
      .prepare(
        `INSERT INTO author_metrics
          (author, influence_score, observed_posts, top_hit_rate, subreddit_count, computed_at_utc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(author) DO UPDATE SET
           influence_score = excluded.influence_score,
           observed_posts = excluded.observed_posts,
           top_hit_rate = excluded.top_hit_rate,
           subreddit_count = excluded.subreddit_count,
           computed_at_utc = excluded.computed_at_utc`,
      )
      .bind(
        row.author,
        Math.round(influence * 1_000) / 1_000,
        row.observed_posts,
        hitRate,
        row.subreddit_count,
        now,
      );
  });
  await db.batch(statements);
}

export async function runHourly(env: CollectorEnv, scheduledAtMs: number): Promise<JobResult> {
  const logicalHour = logicalHourIso(scheduledAtMs);
  if (!(await acquireJob(env.DB, 'hourly', logicalHour))) {
    return { status: 'skipped', kind: 'hourly', logicalTimeUtc: logicalHour };
  }
  const observedAt = new Date().toISOString();

  try {
    await env.DB
      .prepare(
        `INSERT INTO hourly_runs
          (logical_hour_utc, started_at_utc, status, candidate_count, selected_count)
         VALUES (?1, ?2, 'running', 0, 0)
         ON CONFLICT(logical_hour_utc) DO UPDATE SET
           started_at_utc = excluded.started_at_utc,
           completed_at_utc = NULL,
           status = 'running',
           error = NULL`,
      )
      .bind(logicalHour, observedAt)
      .run();

    const session = await createRedditSession(env);
    const [discovered, trackers, previousState] = await Promise.all([
      discoverRedditCandidates(env, session),
      loadActiveTrackers(env.DB),
      loadPreviousState(env.DB, logicalHour),
    ]);
    const trackedRaw = trackers.length
      ? await refreshTrackedPosts(env, trackers.map((tracker) => tracker.postId), session)
      : [];
    const keywords = parseCsv(env.ETF_KEYWORDS, DEFAULT_ETF_KEYWORDS);
    const merged = new Map(discovered.map((candidate) => [candidate.id, candidate]));
    const invalidTrackedIds = new Set(trackers.map((tracker) => tracker.postId));
    trackedRaw.forEach((child) => {
      const candidate = normalizeRedditPost(child, 'tracked', 50, keywords);
      const rawId =
        typeof child.data?.id === 'string' || typeof child.data?.id === 'number'
          ? `t3_${String(child.data.id).toLowerCase()}`
          : null;
      if (candidate) {
        if (rawId) invalidTrackedIds.delete(rawId);
        merged.set(candidate.id, mergeCandidate(merged.get(candidate.id), candidate));
      }
    });

    const scored = scoreCandidates(
      [...merged.values()],
      scheduledAtMs,
      previousState.observations,
      previousState.authors,
      previousState.ranks,
    );
    const discoveredIds = new Set(discovered.map((candidate) => candidate.id));
    const selected = selectTopStories(scored.filter((candidate) => discoveredIds.has(candidate.id)));
    const persistIds = new Set([
      ...selected.map((candidate) => candidate.id),
      ...trackers.map((tracker) => tracker.postId),
    ]);
    const persisted = scored.filter((candidate) => persistIds.has(candidate.id));
    await Promise.all(
      persisted.map(async (candidate) => {
        candidate.contentHash = await sha256Hex(`${candidate.title}\n${candidate.body}`);
      }),
    );
    const existing = await loadExistingPosts(env.DB, persisted.map((candidate) => candidate.id));

    const statements: D1PreparedStatement[] = [];
    persisted.forEach((candidate) => {
      statements.push(postUpsert(env.DB, candidate, observedAt));
      statements.push(observationUpsert(env.DB, candidate, logicalHour, observedAt));
    });
    invalidTrackedIds.forEach((id) => {
      statements.push(
        env.DB
          .prepare(
            `UPDATE reddit_posts SET
               author = NULL,
               title_original = '[deleted]',
               body_original = '',
               title_zh = NULL,
               translation_zh = NULL,
               summary_zh = NULL,
               highlights_json = '[]',
               topics_json = '[]',
               analysis_status = 'deleted',
               deleted_at_utc = ?1,
               last_seen_at_utc = ?1
             WHERE id = ?2`,
          )
          .bind(observedAt, id),
      );
    });

    statements.push(
      env.DB
        .prepare("UPDATE tracking_episodes SET status = 'completed' WHERE status = 'active' AND expires_at_utc <= ?1")
        .bind(logicalHour),
    );

    const activeByPost = new Map(
      trackers
        .filter((tracker) => tracker.expiresAtUtc > logicalHour)
        .map((tracker) => [tracker.postId, tracker]),
    );
    let activeCount = activeByPost.size;
    selected.forEach((candidate) => {
      const active = activeByPost.get(candidate.id);
      if (active) {
        statements.push(
          env.DB
            .prepare(
              `UPDATE tracking_episodes
               SET last_selected_at_utc = ?1, selected_count = selected_count + 1
               WHERE id = ?2`,
            )
            .bind(logicalHour, active.id),
        );
      } else if (activeCount < MAX_TRACKED_POSTS) {
        const expires = new Date(Date.parse(logicalHour) + 24 * 60 * 60 * 1_000).toISOString();
        statements.push(
          env.DB
            .prepare(
              `INSERT INTO tracking_episodes
                (id, post_id, started_at_utc, expires_at_utc, last_selected_at_utc, selected_count, status)
               VALUES (?1, ?2, ?3, ?4, ?3, 1, 'active')`,
            )
            .bind(`${candidate.id}:${logicalHour}`, candidate.id, logicalHour, expires),
        );
        activeCount += 1;
      }
    });

    statements.push(
      env.DB.prepare('DELETE FROM hourly_rankings WHERE logical_hour_utc = ?1').bind(logicalHour),
    );
    selected.forEach((candidate, index) => {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO hourly_rankings
              (logical_hour_utc, rank, post_id, heat_score, components_json, previous_rank)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(
            logicalHour,
            index + 1,
            candidate.id,
            candidate.heatScore,
            JSON.stringify(candidate.components),
            candidate.previousRank,
          ),
      );
    });
    statements.push(
      env.DB
        .prepare(
          `UPDATE hourly_runs SET
             completed_at_utc = ?1,
             status = 'completed',
             candidate_count = ?2,
             selected_count = ?3,
             error = NULL
           WHERE logical_hour_utc = ?4`,
        )
        .bind(new Date().toISOString(), discovered.length, selected.length, logicalHour),
    );

    if (statements.length) await env.DB.batch(statements);
    await analyzeSelected(env, selected, existing);
    await refreshAuthorMetrics(env.DB, observedAt);
    await finishJob(env.DB, 'hourly', logicalHour, 'completed');
    return {
      status: 'completed',
      kind: 'hourly',
      logicalTimeUtc: logicalHour,
      selected: selected.length,
      candidates: discovered.length,
    };
  } catch (error) {
    const message = errorMessage(error);
    await Promise.allSettled([
      finishJob(env.DB, 'hourly', logicalHour, 'failed', message),
      env.DB
        .prepare(
          `UPDATE hourly_runs SET status = 'failed', completed_at_utc = ?1, error = ?2
           WHERE logical_hour_utc = ?3`,
        )
        .bind(new Date().toISOString(), message, logicalHour)
        .run(),
    ]);
    throw error;
  }
}

async function topStoriesForWindow(db: D1Database, startUtc: string, endUtc: string) {
  return rows<{
    id: string;
    title: string;
    subreddit: string;
    author: string | null;
    peak_heat: number;
    appearances: number;
    peak_rank: number;
  }>(
    db
      .prepare(
        `SELECT p.id,
                COALESCE(p.title_zh, p.title_original) AS title,
                p.subreddit,
                p.author,
                MAX(hr.heat_score) AS peak_heat,
                COUNT(*) AS appearances,
                MIN(hr.rank) AS peak_rank
         FROM hourly_rankings hr
         JOIN reddit_posts p ON p.id = hr.post_id
         WHERE hr.logical_hour_utc >= ?1 AND hr.logical_hour_utc < ?2
         GROUP BY p.id
         ORDER BY peak_heat DESC, appearances DESC, p.id ASC
         LIMIT 20`,
      )
      .bind(startUtc, endUtc),
  );
}

export async function runDaily(env: CollectorEnv, scheduledAtMs: number): Promise<JobResult> {
  const window = previousBeijingDayWindow(scheduledAtMs);
  const logicalTime = window.endUtc;
  if (!(await acquireJob(env.DB, 'daily', logicalTime))) {
    return { status: 'skipped', kind: 'daily', logicalTimeUtc: logicalTime, reportLabel: window.label };
  }
  try {
    const [topStories, coverageRows] = await Promise.all([
      topStoriesForWindow(env.DB, window.startUtc, window.endUtc),
      rows<{ count: number }>(
        env.DB
          .prepare(
            `SELECT COUNT(*) AS count FROM hourly_runs
             WHERE logical_hour_utc >= ?1 AND logical_hour_utc < ?2 AND status = 'completed'`,
          )
          .bind(window.startUtc, window.endUtc),
      ),
    ]);
    const coverage = Number(coverageRows[0]?.count ?? 0);
    const facts = { reportDate: window.label, coverage: `${coverage}/24`, topStories };
    const generated = await summarizeReport(env, 'daily', facts);
    const headline = generated?.headline || `${window.label} Reddit ETF 热门话题日报`;
    const executiveSummary =
      generated?.executiveSummary ||
      (topStories.length
        ? `今日共整理 ${topStories.length} 个高互动 ETF 话题，完整度 ${coverage}/24。`
        : `本日暂无足够数据生成话题摘要，完整度 ${coverage}/24。`);
    const sections = {
      themes: generated?.themes ?? [],
      topStories,
      missingHours: Math.max(0, 24 - coverage),
      source: 'reddit',
    };
    await env.DB
      .prepare(
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

    const retentionHours = Math.max(24, Number(env.RAW_CONTENT_RETENTION_HOURS ?? 48));
    const cutoff = new Date(scheduledAtMs - retentionHours * 3_600_000).toISOString();
    await env.DB
      .prepare(
        `UPDATE reddit_posts SET
           author = NULL,
           outbound_url = NULL,
           title_original = '[content expired]',
           body_original = '',
           title_zh = NULL,
           translation_zh = NULL,
           summary_zh = NULL,
           highlights_json = '[]',
           topics_json = '[]',
           analysis_status = 'expired'
         WHERE last_seen_at_utc < ?1
           AND analysis_status NOT IN ('expired', 'deleted')`,
      )
      .bind(cutoff)
      .run();

    await finishJob(env.DB, 'daily', logicalTime, 'completed');
    return {
      status: 'completed',
      kind: 'daily',
      logicalTimeUtc: logicalTime,
      reportLabel: window.label,
    };
  } catch (error) {
    await finishJob(env.DB, 'daily', logicalTime, 'failed', errorMessage(error));
    throw error;
  }
}

export async function runWeekly(env: CollectorEnv, scheduledAtMs: number): Promise<JobResult> {
  const window = previousBeijingWeekWindow(scheduledAtMs);
  const logicalTime = window.endUtc;
  if (!(await acquireJob(env.DB, 'weekly', logicalTime))) {
    return { status: 'skipped', kind: 'weekly', logicalTimeUtc: logicalTime, reportLabel: window.label };
  }
  try {
    const [topStories, daily] = await Promise.all([
      topStoriesForWindow(env.DB, window.startUtc, window.endUtc),
      rows<{
        report_date: string;
        headline: string;
        executive_summary: string;
        coverage_success: number;
      }>(
        env.DB
          .prepare(
            `SELECT report_date, headline, executive_summary, coverage_success
             FROM daily_reports
             WHERE period_start_utc >= ?1 AND period_end_utc <= ?2
             ORDER BY report_date ASC`,
          )
          .bind(window.startUtc, window.endUtc),
      ),
    ]);
    const facts = { weekStart: window.label, daysIncluded: daily.length, daily, topStories };
    const generated = await summarizeReport(env, 'weekly', facts);
    const headline = generated?.headline || `ETF 热门话题周报｜${window.label}`;
    const executiveSummary =
      generated?.executiveSummary ||
      `本周汇总 ${daily.length} 份 Reddit ETF 日报与 ${topStories.length} 个重点话题。`;
    const sections = { themes: generated?.themes ?? [], daily, topStories, source: 'reddit' };
    await env.DB
      .prepare(
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
    await finishJob(env.DB, 'weekly', logicalTime, 'completed');
    return {
      status: 'completed',
      kind: 'weekly',
      logicalTimeUtc: logicalTime,
      reportLabel: window.label,
    };
  } catch (error) {
    await finishJob(env.DB, 'weekly', logicalTime, 'failed', errorMessage(error));
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
