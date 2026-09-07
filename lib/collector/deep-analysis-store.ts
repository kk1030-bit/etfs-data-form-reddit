import {
  DEEP_COMMUNITIES,
  DEEP_POST_FIELDS,
  type DeepPost,
} from './deep-analysis-source.ts';
import { scoreDeepAnalysis } from './deep-analysis.ts';
import {
  deepFinalScore,
  rankDeepCandidates,
  type DeepDailySnapshot,
} from './deep-analysis-daily.ts';
import {
  compareDeepRecent,
  deepPublishedMs,
  DEEP_WINDOW_MS,
} from './deep-analysis-dates.ts';
import {
  analyzeDeepPost,
  deepAiApproved,
  deepAiTotal,
  type DeepAiResult,
  type DeepAiScores,
} from './deep-analysis-ai.ts';
import {
  DEEP_RUBRIC_VERSION,
  DEEP_DAILY_REVIEWS,
  DEEP_CANDIDATE_LIMIT,
} from './deep-analysis-policy.ts';
import type { LlmEnv } from './llm.ts';

export type DeepCard = {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  authorFlair: string | null;
  publishedAt: string;
  firstSeenAt: string;
  score: number;
  baseScore: number;
  characters: number;
  readingMinutes: number;
  primarySourceCount: number;
  hasTable: boolean;
  authorLongPosts: number | null;
  uniqueCommenters: number | null;
  tickers: string[];
  thesis: string;
  keyData: string[];
  counterpoints: string;
  backgroundClaimed: string | null;
  type: DeepAiResult['type'];
  quality?: number; // Previously published v1 cards only.
  aiScores?: DeepAiScores;
  rubricVersion?: string;
  permalink: string;
};
export type DeepWeeklyHighlight = Pick<
  DeepCard,
  'thesis' | 'keyData' | 'counterpoints' | 'score'
>;
export type DeepData = {
  articles: DeepCard[];
  candidates?: DeepCandidateCard[];
  updatedAt: string | null;
  error: string | null;
  lastRun: {
    day: string;
    status: string;
    accepted: number;
    rejected: number;
    failed: number;
    startedAt: string;
    completedAt: string | null;
  } | null;
};
export type DeepCandidateCard = {
  id: string;
  title: string;
  subreddit: string;
  characters: number;
  score: number;
  publishedAt: string;
};
type DeepEnv = LlmEnv & { DB: D1Database; TITLE_INGEST_TOKEN?: string };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const iso = (ms: number) => new Date(ms).toISOString();
const safeId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-z0-9]{1,16}$/.test(id);

export function buildDeepCard(
  {
    post,
    uniqueCommenters,
    authorLongPosts,
  }: import('./deep-analysis-daily.ts').DeepFinalist,
  ai: DeepAiResult,
  at: string,
): DeepCard {
  const base = scoreDeepAnalysis(post);
  const score = deepFinalScore({ post, uniqueCommenters, authorLongPosts });
  return {
    id: String(post.id),
    title: ai.title_zh,
    subreddit: post.subreddit,
    author: String(post.author),
    authorFlair:
      typeof post.author_flair_text === 'string' &&
      post.author_flair_text.trim()
        ? post.author_flair_text.trim().slice(0, 300)
        : null,
    publishedAt: iso(Number(post.created_utc) * 1000),
    firstSeenAt: at,
    score,
    baseScore: base.score,
    characters: base.details.characters,
    readingMinutes: Math.max(1, Math.ceil(base.details.characters / 1000)),
    primarySourceCount: base.details.primarySources.length,
    hasTable: base.details.structure.table,
    authorLongPosts,
    uniqueCommenters,
    tickers: base.details.tickers,
    thesis: ai.thesis,
    keyData: ai.key_data,
    counterpoints: ai.counterpoints,
    backgroundClaimed: ai.author_background_claimed,
    type: ai.type,
    aiScores: ai.scores,
    rubricVersion: DEEP_RUBRIC_VERSION,
    permalink: `https://www.reddit.com/r/${post.subreddit}/comments/${String(post.id)}/`,
  };
}

export async function readDeepData(
  db: D1Database,
  now = Date.now(),
): Promise<DeepData> {
  try {
    const [articles, run, completed, candidates] = await Promise.all([
      db
        .prepare(
          'SELECT id, published_at_utc, score, card_json FROM deep_analysis_articles WHERE published_at_utc >= ?1 AND published_at_utc <= ?2 ORDER BY published_at_utc DESC, score DESC, id ASC LIMIT 56',
        )
        .bind(iso(now - DEEP_WINDOW_MS), iso(now))
        .all<{
          id: string;
          published_at_utc: string;
          score: number;
          card_json: string;
        }>(),
      db
        .prepare(
          'SELECT day, status, accepted, rejected, failed, started_at_utc AS startedAt, completed_at_utc AS completedAt FROM deep_analysis_runs ORDER BY day DESC LIMIT 1',
        )
        .first<NonNullable<DeepData['lastRun']>>(),
      db
        .prepare(
          "SELECT completed_at_utc FROM deep_analysis_runs WHERE status IN ('completed', 'partial') ORDER BY day DESC LIMIT 1",
        )
        .first<{ completed_at_utc: string }>(),
      db
        .prepare(`SELECT c.id, c.title, c.subreddit, c.characters, c.score, c.published_at_utc AS publishedAt
        FROM deep_analysis_candidates c WHERE c.published_at_utc >= ?1 AND c.published_at_utc <= ?2
        AND c.rubric_version = ?3 AND c.status != 'accepted'
        AND NOT EXISTS (SELECT 1 FROM deep_analysis_articles a WHERE a.id = c.id)
        ORDER BY c.score DESC, c.published_at_utc DESC, c.id ASC LIMIT 10`)
        .bind(iso(now - DEEP_WINDOW_MS), iso(now), DEEP_RUBRIC_VERSION)
        .all<DeepCandidateCard>(),
    ]);
    return {
      articles: articles.results
        .map(
          (r) =>
            ({
              ...JSON.parse(r.card_json),
              id: r.id,
              publishedAt: r.published_at_utc,
              score: r.score,
            }) as DeepCard,
        )
        .sort(compareDeepRecent),
      updatedAt: completed?.completed_at_utc ?? null,
      candidates: candidates.results,
      lastRun: run,
      error: null,
    };
  } catch {
    return {
      articles: [],
      candidates: [],
      updatedAt: null,
      lastRun: null,
      error: '暂时无法读取深度分析，请稍后刷新。',
    };
  }
}

/** Weekly storage remains de-identified: no author, original title, or retained permalink. */
export async function readDeepWeekly(
  db: D1Database,
  start: string,
  end: string,
): Promise<DeepWeeklyHighlight[]> {
  const rows = await db
    .prepare(
      'SELECT card_json FROM deep_analysis_articles WHERE published_at_utc >= ?1 AND published_at_utc < ?2 ORDER BY score DESC, published_at_utc DESC, id ASC LIMIT 3',
    )
    .bind(start, end)
    .all<{ card_json: string }>();
  return rows.results.map((row) => {
    const card = JSON.parse(row.card_json) as DeepCard;
    const anonymize = (value: string) => {
      const escapedAuthor = card.author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return value
        .replace(/https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/\S+/gi, '原帖')
        .replace(/\b(?:u|user)\/[a-z0-9_-]+/gi, '作者')
        .replace(new RegExp(`\\b${escapedAuthor}\\b`, 'gi'), '作者');
    };
    return {
      thesis: anonymize(card.thesis),
      keyData: card.keyData.map(anonymize),
      counterpoints: anonymize(card.counterpoints),
      score: card.score,
    };
  });
}

export async function beginDeepRun(db: D1Database, now = Date.now()) {
  const cutoff = iso(now - DEEP_WINDOW_MS),
    day = iso(now).slice(0, 10);
  const token = crypto.randomUUID();
  const reserved = await db
    .prepare(
      "INSERT INTO deep_analysis_runs (day, token, status, started_at_utc) VALUES (?1, ?2, 'collecting', ?3) ON CONFLICT(day) DO NOTHING",
    )
    .bind(day, token, iso(now))
    .run();
  // Claim first: duplicate dispatch cannot race cleanup or reset the daily budget.
  if (!reserved.meta.changes) return { needed: false, day };
  await db.batch([
    db
      .prepare('DELETE FROM deep_analysis_articles WHERE published_at_utc < ?1')
      .bind(cutoff),
    db
      .prepare('DELETE FROM deep_analysis_seen WHERE seen_at_utc <= ?1')
      .bind(cutoff),
    db
      .prepare(
        'DELETE FROM deep_analysis_candidates WHERE published_at_utc < ?1',
      )
      .bind(cutoff),
    db
      .prepare('DELETE FROM deep_analysis_authors WHERE checked_at_utc <= ?1')
      .bind(cutoff),
    db
      .prepare('DELETE FROM deep_analysis_runs WHERE day < ?1')
      .bind(cutoff.slice(0, 10)),
  ]);
  const [seen, authors] = await Promise.all([
    db
      .prepare(
        'SELECT id FROM deep_analysis_seen WHERE seen_at_utc > ?1 AND rubric_version = ?2 UNION SELECT id FROM deep_analysis_articles WHERE published_at_utc >= ?1',
      )
      .bind(cutoff, DEEP_RUBRIC_VERSION)
      .all<{ id: string }>(),
    db
      .prepare(
        'SELECT author, long_posts, checked_at_utc FROM deep_analysis_authors WHERE checked_at_utc > ?1',
      )
      .bind(cutoff)
      .all<{ author: string; long_posts: number; checked_at_utc: string }>(),
  ]);
  return {
    needed: true,
    day,
    token,
    scheduledAtMs: now,
    seenIds: seen.results.map((r) => r.id),
    authors: authors.results.map((r) => ({
      author: r.author,
      longPosts: r.long_posts,
      checkedAt: r.checked_at_utc,
    })),
  };
}

export function validateDeepSnapshot(
  value: unknown,
  startedAt: number,
  now = Date.now(),
): DeepDailySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid snapshot');
  const row = value as DeepDailySnapshot;
  if (
    typeof row.collectedAt !== 'string' ||
    Date.parse(row.collectedAt) !== startedAt ||
    !Number.isInteger(row.requests) ||
    row.requests < 7 ||
    row.requests > 25 ||
    !Array.isArray(row.communities) ||
    row.communities.length !== 7 ||
    !Array.isArray(row.seenIds) ||
    row.seenIds.length > 7000 ||
    !row.seenIds.every(safeId) ||
    new Set(row.seenIds).size !== row.seenIds.length ||
    !Array.isArray(row.finalists) ||
    row.finalists.length > DEEP_DAILY_REVIEWS ||
    !Array.isArray(row.candidates) ||
    row.candidates.length > DEEP_CANDIDATE_LIMIT ||
    !Array.isArray(row.authors) ||
    row.authors.length > DEEP_DAILY_REVIEWS
  )
    throw new Error('Invalid snapshot limits');
  for (let i = 0; i < DEEP_COMMUNITIES.length; i++) {
    if (
      row.communities[i]?.subreddit !== DEEP_COMMUNITIES[i] ||
      !Number.isInteger(row.communities[i]?.returned) ||
      row.communities[i].returned < 0 ||
      row.communities[i].returned > 1000
    )
      throw new Error('Invalid community coverage');
  }
  const count = (value: unknown, max: number) =>
    value === null ||
    (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max);
  if (
    row.screening &&
    (!Number.isInteger(row.screening.considered) ||
      row.screening.considered < 0 ||
      row.screening.considered > 7000 ||
      !Number.isInteger(row.screening.eligible) ||
      row.screening.eligible < 0 ||
      row.screening.eligible > row.screening.considered ||
      !Number.isInteger(row.screening.qualified) ||
      row.screening.qualified < row.finalists.length ||
      row.screening.qualified > row.screening.eligible)
  )
    throw new Error('Invalid screening counts');
  const ids = new Set<string>();
  for (const item of row.candidates) {
    if (!item || typeof item !== 'object') throw new Error('Invalid finalist');
    const p = item.post;
    if (
      !p ||
      typeof p !== 'object' ||
      !safeId(p.id) ||
      ids.has(p.id) ||
      !DEEP_COMMUNITIES.includes(
        p.subreddit as (typeof DEEP_COMMUNITIES)[number],
      ) ||
      typeof p.title !== 'string' ||
      p.title.length > 1000 ||
      typeof p.selftext !== 'string' ||
      p.selftext.length > 200000 ||
      typeof p.author !== 'string' ||
      p.author.length > 32 ||
      (p.author_flair_text !== null &&
        typeof p.author_flair_text !== 'string') ||
      String(p.author_flair_text ?? '').length > 1000 ||
      !count(item.uniqueCommenters, 100000) ||
      !count(item.authorLongPosts, 50)
    )
      throw new Error('Invalid finalist fields');
    const published = deepPublishedMs(p.created_utc, now);
    if (
      published === null ||
      published > startedAt ||
      published < startedAt - 72 * 3600000 ||
      !scoreDeepAnalysis(p).finalist
    )
      throw new Error('Ineligible or stale finalist');
    ids.add(p.id);
    // Strip any extra upstream keys before the AI and persistence boundary.
    const post = { subreddit: p.subreddit } as DeepPost;
    for (const field of DEEP_POST_FIELDS) post[field] = p[field] ?? null;
    item.post = post;
  }
  const selected = rankDeepCandidates(row.candidates).slice(
    0,
    DEEP_DAILY_REVIEWS,
  );
  if (
    row.finalists.length !== selected.length ||
    row.finalists.some(
      (f, i) =>
        !f?.post ||
        f.post.id !== selected[i].post.id ||
        !row.seenIds.includes(String(f.post.id)),
    )
  )
    throw new Error('Finalists must be the score-ranked top five');
  // Never trust the separately supplied finalist body or counters.
  row.finalists = selected;
  for (const a of row.authors) {
    if (
      !a ||
      typeof a.author !== 'string' ||
      !/^[a-z0-9_-]{1,32}$/i.test(a.author) ||
      !Number.isInteger(a.longPosts) ||
      a.longPosts < 0 ||
      a.longPosts > 50 ||
      typeof a.checkedAt !== 'string' ||
      Date.parse(a.checkedAt) !== startedAt ||
      !row.finalists.some(
        (f) => String(f.post.author).toLowerCase() === a.author.toLowerCase(),
      )
    )
      throw new Error('Invalid author cache');
  }
  return row;
}

export async function ingestDeepRun(
  env: DeepEnv,
  day: string,
  token: string,
  snapshot: unknown,
  now = Date.now(),
  analyze = analyzeDeepPost,
) {
  const run = await env.DB.prepare(
    "SELECT started_at_utc FROM deep_analysis_runs WHERE day = ?1 AND token = ?2 AND status = 'collecting'",
  )
    .bind(day, token)
    .first<{ started_at_utc: string }>();
  if (
    !run ||
    now - Date.parse(run.started_at_utc) > 20 * 60000 ||
    now < Date.parse(run.started_at_utc)
  )
    throw new Error('Expired or duplicate run');
  const data = validateDeepSnapshot(
    snapshot,
    Date.parse(run.started_at_utc),
    now,
  );
  const lease = await env.DB.prepare(
    "UPDATE deep_analysis_runs SET status = 'processing', requests = ?3, details_json = ?4 WHERE day = ?1 AND token = ?2 AND status = 'collecting'",
  )
    .bind(
      day,
      token,
      data.requests,
      JSON.stringify({
        communities: data.communities,
        screening: data.screening,
      }),
    )
    .run();
  if (!lease.meta.changes) throw new Error('Run already ingested');
  const at = iso(now);
  const alreadySeen = new Set<string>();
  for (const item of data.finalists) {
    const seen = await env.DB.prepare(
      'SELECT id FROM deep_analysis_seen WHERE id = ?1 AND seen_at_utc > ?2 AND rubric_version = ?3 UNION SELECT id FROM deep_analysis_articles WHERE id = ?1',
    )
      .bind(item.post.id, iso(now - DEEP_WINDOW_MS), DEEP_RUBRIC_VERSION)
      .first<{ id: string }>();
    if (seen) alreadySeen.add(seen.id);
  }
  // Bound batches; each statement stays below D1's 100 parameter limit.
  for (let i = 0; i < data.seenIds.length; i += 50) {
    await env.DB.batch(
      data.seenIds
        .slice(i, i + 50)
        .map((id) =>
          env.DB.prepare(
            'INSERT INTO deep_analysis_seen (id, seen_at_utc, rubric_version) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET seen_at_utc = excluded.seen_at_utc, rubric_version = excluded.rubric_version WHERE rubric_version != excluded.rubric_version',
          ).bind(id, at, DEEP_RUBRIC_VERSION),
        ),
    );
  }
  for (const a of data.authors)
    await env.DB.prepare(
      'INSERT INTO deep_analysis_authors (author, long_posts, checked_at_utc) VALUES (?1, ?2, ?3) ON CONFLICT(author) DO UPDATE SET long_posts = excluded.long_posts, checked_at_utc = excluded.checked_at_utc',
    )
      .bind(a.author.toLowerCase(), a.longPosts, a.checkedAt)
      .run();
  let accepted = 0,
    rejected = 0,
    failed = 0;
  const aiUsage = { requests: 0 };
  const diagnostics: Array<Record<string, unknown>> = [];
  for (const item of data.candidates) {
    const base = scoreDeepAnalysis(item.post);
    await env.DB.prepare(`INSERT INTO deep_analysis_candidates (id, title, subreddit, characters, score, published_at_utc, status, rubric_version)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7) ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, characters = excluded.characters, score = excluded.score,
      status = CASE WHEN rubric_version = excluded.rubric_version THEN status ELSE 'pending' END,
      rubric_version = excluded.rubric_version`)
      .bind(
        String(item.post.id),
        String(item.post.title),
        item.post.subreddit,
        base.details.characters,
        deepFinalScore(item),
        iso(Number(item.post.created_utc) * 1000),
        DEEP_RUBRIC_VERSION,
      )
      .run();
  }
  const candidateStatus = (id: unknown, status: string) =>
    env.DB.prepare(
      'UPDATE deep_analysis_candidates SET status = ?2 WHERE id = ?1',
    )
      .bind(String(id), status)
      .run();
  for (const { post, uniqueCommenters, authorLongPosts } of data.finalists) {
    if (alreadySeen.has(String(post.id))) continue;
    try {
      const ai = await analyze(
        {
          ...env,
          AI_CALLS: aiUsage,
          AI_TRACE: (event) => diagnostics.push({ id: post.id, ...event }),
        },
        post,
        uniqueCommenters,
      );
      if (!deepAiApproved(ai)) {
        await candidateStatus(post.id, 'rejected');
        rejected++;
        continue;
      }
      const card = buildDeepCard(
        { post, uniqueCommenters, authorLongPosts },
        ai,
        at,
      );
      const score = card.score;
      await env.DB.prepare(
        'INSERT INTO deep_analysis_articles (id, published_at_utc, first_seen_at_utc, score, card_json) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO NOTHING',
      )
        .bind(card.id, card.publishedAt, at, score, JSON.stringify(card))
        .run();
      accepted++;
      await candidateStatus(post.id, 'accepted');
    } catch {
      failed++;
      await candidateStatus(post.id, 'failed');
      // Technical failures remain eligible for tomorrow, unlike editorial rejection.
      await env.DB.prepare(
        'DELETE FROM deep_analysis_seen WHERE id = ?1 AND seen_at_utc = ?2 AND rubric_version = ?3',
      )
        .bind(String(post.id), at, DEEP_RUBRIC_VERSION)
        .run();
    }
  }
  const status = failed ? 'partial' : 'completed';
  await env.DB.prepare(
    'UPDATE deep_analysis_runs SET status = ?3, completed_at_utc = ?4, accepted = ?5, rejected = ?6, failed = ?7, details_json = ?8 WHERE day = ?1 AND token = ?2',
  )
    .bind(
      day,
      token,
      status,
      iso(Date.now()),
      accepted,
      rejected,
      failed,
      JSON.stringify({
        communities: data.communities,
        screening: data.screening,
        aiCalls: aiUsage.requests,
      }),
    )
    .run();
  return {
    status,
    accepted,
    rejected,
    failed,
    requests: data.requests,
    aiCalls: aiUsage.requests,
    diagnostics,
  };
}

export async function handleDeepRequest(
  request: Request,
  env: DeepEnv,
): Promise<Response> {
  if (
    !env.TITLE_INGEST_TOKEN ||
    request.headers.get('authorization') !== `Bearer ${env.TITLE_INGEST_TOKEN}`
  )
    return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'POST')
    return json({ error: 'Method not allowed' }, 405);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return json({ error: 'JSON required' }, 415);
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Body required' }, 400);
    let size = 0,
      raw = '';
    const decoder = new TextDecoder();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4_000_000) {
        await reader.cancel();
        return json({ error: 'Input too large' }, 413);
      }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
    const input = JSON.parse(raw) as {
      action?: string;
      day?: string;
      token?: string;
      snapshot?: unknown;
      upstreamStatus?: number;
      requests?: number;
      retryAfter?: string;
      post?: unknown;
    };
    if (input.action === 'begin') return json(await beginDeepRun(env.DB));
    if (input.action === 'calibrate')
      return json(await calibrateDeepPost(env, input.post));
    if (
      typeof input.day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
      typeof input.token !== 'string' ||
      input.token.length > 100
    )
      return json({ error: 'Run required' }, 400);
    if (input.action === 'ingest')
      return json(
        await ingestDeepRun(env, input.day, input.token, input.snapshot),
      );
    if (input.action === 'failed') {
      if (
        !Number.isInteger(input.requests) ||
        Number(input.requests) < 0 ||
        Number(input.requests) > 25 ||
        (input.upstreamStatus !== undefined &&
          (!Number.isInteger(input.upstreamStatus) ||
            input.upstreamStatus < 400 ||
            input.upstreamStatus > 599)) ||
        (input.retryAfter !== undefined &&
          (typeof input.retryAfter !== 'string' ||
            input.retryAfter.length > 100))
      )
        return json({ error: 'Invalid failure' }, 400);
      const result = await env.DB.prepare(
        "UPDATE deep_analysis_runs SET status = 'failed', completed_at_utc = ?3, requests = ?4, details_json = ?5 WHERE day = ?1 AND token = ?2 AND status = 'collecting'",
      )
        .bind(
          input.day,
          input.token,
          iso(Date.now()),
          input.requests!,
          JSON.stringify({
            upstreamStatus: input.upstreamStatus ?? null,
            retryAfter: input.retryAfter ?? null,
          }),
        )
        .run();
      return json({ status: result.meta.changes ? 'failed' : 'ignored' });
    }
    return json({ error: 'Invalid action' }, 400);
  } catch {
    // Never log article bodies, AI prompts, credentials, or arbitrary upstream errors.
    return json(
      { error: 'Deep collection input rejected or run unavailable' },
      422,
    );
  }
}

/** Authenticated, review-only calibration: never publishes, mutates daily runs or consumes source requests. */
export async function calibrateDeepPost(
  env: DeepEnv,
  value: unknown,
  now = Date.now(),
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid calibration post');
  const p = value as DeepPost;
  const created = Number(p.created_utc) * 1000;
  if (
    !safeId(p.id) ||
    !DEEP_COMMUNITIES.includes(
      p.subreddit as (typeof DEEP_COMMUNITIES)[number],
    ) ||
    typeof p.created_utc !== 'number' ||
    !Number.isFinite(created) ||
    created > now ||
    created < now - 30 * 86400000 ||
    typeof p.selftext !== 'string' ||
    Array.from(p.selftext.trim()).length < 1000 ||
    p.selftext.length > 200000 ||
    typeof p.title !== 'string' ||
    p.title.length > 1000 ||
    p.is_self !== true ||
    (typeof p.author_flair_text !== 'string' && p.author_flair_text !== null)
  )
    throw new Error('Invalid calibration post');
  // Calibration must share the existing atomic global 128/day guard; no paid fallback.
  if (!env.WORKERS_AI_RELAY_URL || !env.WORKERS_AI_RELAY_TOKEN)
    throw new Error('Calibration requires budgeted AI relay');
  const post = { subreddit: p.subreddit } as DeepPost;
  for (const field of DEEP_POST_FIELDS) post[field] = p[field] ?? null;
  const base = scoreDeepAnalysis(post);
  const diagnostics: Array<Record<string, unknown>> = [];
  const usage = { requests: 0 };
  try {
    const ai = await analyzeDeepPost(
      {
        ...env,
        AI_CALLS: usage,
        AI_TRACE: (event) => diagnostics.push(event),
        AI_BEFORE_CALL: async () => {
          const reserved =
            await env.DB.prepare(`INSERT INTO deep_calibration_usage (day, requests) VALUES (?1, 1)
          ON CONFLICT(day) DO UPDATE SET requests = requests + 1 WHERE requests < 40`)
              .bind(iso(Date.now()).slice(0, 10))
              .run();
          if (!reserved.meta.changes)
            throw new Error('Daily calibration AI budget reached');
        },
      },
      post,
    );
    return {
      id: p.id,
      rubricVersion: DEEP_RUBRIC_VERSION,
      status: deepAiApproved(ai) ? 'accepted' : 'rejected',
      scores: ai.scores,
      total: deepAiTotal(ai),
      features: base.points,
      details: base.details,
      aiCalls: usage.requests,
      diagnostics,
    };
  } catch (error) {
    const budget = error instanceof Error && /budget/i.test(error.message);
    return {
      id: p.id,
      rubricVersion: DEEP_RUBRIC_VERSION,
      status: budget ? 'budget' : 'failed',
      features: base.points,
      details: base.details,
      aiCalls: usage.requests,
      diagnostics,
    };
  }
}
