import {
  DEFAULT_ETF_KEYWORDS,
  DEFAULT_SUBREDDITS,
  normalizeRedditPost,
  parseCsv,
  beginnerFlairPenalty,
  extractEtfTickers,
  type IndexedCommentObservation,
  type RawRedditPost,
  type RedditCandidate,
} from './core.ts';
import { RedditRssError, type RedditRssEnv } from './reddit-rss.ts';

const ORIGIN = 'https://arctic-shift.photon-reddit.com';
const MAX_BYTES = 2_000_000;
// Only documented selectable fields; retain text for existing local ETF filtering/translation.
export const ARCTIC_POST_FIELDS =
  'id,title,created_utc,author,url,num_comments,over_18,subreddit,selftext,retrieved_on,link_flair_text';
export const ARCTIC_COMMENT_FIELDS = 'id,link_id,created_utc,subreddit';
const PROJECT_USER_AGENT =
  'etfs-hot-topics/0.3 (+https://github.com/kk1030-bit/etfs-data-form-reddit)';

export function arcticRetryAfter(
  headers: Headers,
  nowMs = Date.now(),
): string | undefined {
  const reset = headers.get('x-ratelimit-reset')?.trim();
  if (
    reset &&
    /^\d+(?:\.\d+)?$/.test(reset) &&
    Number.isFinite(Number(reset)) &&
    nowMs + Number(reset) * 1000 <= 8.64e15
  )
    return reset;
  const at = headers.get('x-ratelimit-reset-at')?.trim();
  if (at) {
    const numeric = /^\d+(?:\.\d+)?$/.test(at) ? Number(at) : Number.NaN;
    // The API calls this a timestamp without specifying units: accept epoch seconds, milliseconds or ISO.
    const timestamp = Number.isFinite(numeric)
      ? numeric < 100_000_000_000
        ? numeric * 1000
        : numeric
      : Date.parse(at);
    if (
      Number.isFinite(timestamp) &&
      timestamp >= nowMs &&
      timestamp <= 8.64e15
    )
      return String(Math.ceil((timestamp - nowMs) / 1000));
  }
  const retry = headers.get('retry-after')?.trim();
  if (
    retry &&
    /^\d+(?:\.\d+)?$/.test(retry) &&
    Number.isFinite(Number(retry)) &&
    nowMs + Number(retry) * 1000 <= 8.64e15
  )
    return retry;
  if (retry && Number.isFinite(Date.parse(retry)) && Date.parse(retry) >= nowMs)
    return String(Math.ceil((Date.parse(retry) - nowMs) / 1000));
  return undefined;
}

export function createArcticFetcher(
  fetcher: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): typeof fetch {
  let previousEnd: number | null = null;
  let exhausted: { retryAfter?: string } | null = null;
  return async (input, init) => {
    if (exhausted)
      throw new RedditRssError(
        'Arctic Shift rate budget exhausted',
        429,
        exhausted.retryAfter,
      );
    if (previousEnd !== null)
      await sleep(Math.max(0, 2000 - (now() - previousEnd)));
    let response: Response;
    try {
      response = await fetcher(input, init);
    } finally {
      previousEnd = now();
    }
    const raw = response.headers.get('x-ratelimit-remaining');
    const remaining = raw?.trim() ? Number(raw) : Number.NaN;
    if (Number.isFinite(remaining) && remaining <= 0)
      exhausted = { retryAfter: arcticRetryAfter(response.headers, now()) };
    return response;
  };
}
export type SourceDetails = {
  provider: string;
  communities: string[];
  warnings: string[];
  newestPostAt: string | null;
  newestIndexedAt: string | null;
  commentSampleSize: number;
  commentMetric?: 'indexed-total';
  aggregateRequested?: number;
  aggregateSucceeded?: number;
};

function indexedTime(row: Record<string, unknown>): string | undefined {
  const meta = row._meta as Record<string, unknown> | undefined;
  const seconds = Number(meta?.retrieved_2nd_on ?? row.retrieved_on);
  return Number.isFinite(seconds) && seconds > 0 && seconds < 8.64e12
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}

export function normalizeIndexedPost(
  row: Record<string, unknown>,
  keywords = DEFAULT_ETF_KEYWORDS,
): RedditCandidate | null {
  if (
    row.permalink === undefined &&
    typeof row.id === 'string' &&
    /^(?:t3_)?[a-z0-9]+$/i.test(row.id) &&
    typeof row.subreddit === 'string' &&
    /^[a-z0-9_]{2,21}$/i.test(row.subreddit)
  ) {
    const id = row.id.replace(/^t3_/i, '');
    row = { ...row, id, permalink: `/r/${row.subreddit}/comments/${id}/` };
  }
  const meta = row._meta as Record<string, unknown> | undefined;
  if (
    row.is_robot_indexable === false ||
    meta?.was_deleted_later ||
    meta?.was_initially_deleted ||
    meta?.removal_type
  )
    return null;
  const candidate = normalizeRedditPost(
    { kind: 't3', data: row },
    'arctic-shift',
    1,
    keywords,
  );
  if (!candidate) return null;
  return {
    ...candidate,
    sourceProvider: 'arctic-shift',
    indexedAtUtc: indexedTime(row),
    metricsAvailable: false,
    bestListingRank: null,
    score: 0,
    comments: 0,
    upvoteRatio: 0,
    discussionCount: 0,
  };
}

async function requestRows(
  path: string,
  params: Record<string, string>,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>[]> {
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': PROJECT_USER_AGENT,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429) {
    throw new RedditRssError(
      'Arctic Shift rate limited',
      429,
      arcticRetryAfter(response.headers),
    );
  }
  if (!response.ok)
    throw new RedditRssError(
      `Arctic Shift HTTP ${response.status}`,
      response.status,
    );
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new RedditRssError('Arctic Shift response is not JSON');
  const reader = response.body?.getReader();
  if (!reader) throw new RedditRssError('Arctic Shift empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new RedditRssError('Arctic Shift response exceeds size limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
    data?: unknown;
  };
  if (!Array.isArray(payload.data))
    throw new RedditRssError('Arctic Shift invalid data response');
  if (
    payload.data.some(
      (row) => !row || typeof row !== 'object' || Array.isArray(row),
    )
  )
    throw new RedditRssError('Arctic Shift invalid data row');
  return payload.data as Record<string, unknown>[];
}

export async function fetchIndexedCandidates(
  env: RedditRssEnv,
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
  pacedFetcher?: typeof fetch,
): Promise<{
  candidates: RedditCandidate[];
  details: SourceDetails;
  commentCounts: Map<string, number>;
}> {
  const request = pacedFetcher ?? createArcticFetcher(fetcher);
  const communities = parseCsv(env.REDDIT_SUBREDDITS, DEFAULT_SUBREDDITS)
    .filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s))
    .slice(0, 6);
  const keywords = parseCsv(env.ETF_KEYWORDS, DEFAULT_ETF_KEYWORDS);
  const after = String(Math.floor((nowMs - 24 * 3_600_000) / 1000));
  const before = String(Math.ceil(nowMs / 1000));
  const candidates = new Map<string, RedditCandidate>();
  const details: SourceDetails = {
    provider: 'Arctic Shift',
    communities: [],
    warnings: [],
    newestPostAt: null,
    newestIndexedAt: null,
    commentSampleSize: 0,
  };
  const counts = new Map<string, number>();
  for (const subreddit of communities) {
    try {
      const rows = await requestRows(
        '/api/posts/search',
        {
          subreddit,
          limit: '100',
          sort: 'desc',
          after,
          before,
          fields: ARCTIC_POST_FIELDS,
        },
        request,
      );
      details.communities.push(subreddit);
      for (const row of rows) {
        const post = normalizeIndexedPost(row, keywords);
        if (
          !post ||
          post.subreddit.toLowerCase() !== subreddit.toLowerCase() ||
          Date.parse(post.createdAtUtc) < Number(after) * 1000 ||
          Date.parse(post.createdAtUtc) > nowMs
        )
          continue;
        candidates.set(post.id, post);
        if (!details.newestPostAt || post.createdAtUtc > details.newestPostAt)
          details.newestPostAt = post.createdAtUtc;
        if (
          post.indexedAtUtc &&
          (!details.newestIndexedAt ||
            post.indexedAtUtc > details.newestIndexedAt)
        )
          details.newestIndexedAt = post.indexedAtUtc;
      }
      if (rows.length === 100)
        details.warnings.push(
          `r/${subreddit}：仅取最近 100 篇，未穷尽全部帖子。`,
        );
    } catch (error) {
      if (error instanceof RedditRssError && error.status === 429) throw error;
      details.warnings.push(
        `r/${subreddit}：帖子索引暂不可用（${error instanceof Error ? error.message.slice(0, 180) : 'unknown'}）。`,
      );
    }
  }
  if (!details.communities.length)
    throw new RedditRssError(
      `Arctic Shift 所有社区查询失败：${details.warnings.join(' ').slice(0, 1000)}`,
    );
  return {
    candidates: [...candidates.values()].map((post) => ({
      ...post,
      discussionCount: counts.get(post.id) ?? 0,
    })),
    details,
    commentCounts: counts,
  };
}

export async function refreshIndexedPosts(
  ids: string[],
  fetcher: typeof fetch = fetch,
): Promise<RawRedditPost[]> {
  const safe = [...new Set(ids)]
    .filter((id) => /^t3_[a-z0-9]+$/i.test(id))
    .slice(0, 120);
  if (!safe.length) return [];
  const rows = await requestRows(
    '/api/posts/ids',
    { ids: safe.join(','), fields: ARCTIC_POST_FIELDS },
    fetcher,
  );
  const requested = new Set(safe.map((id) => id.toLowerCase()));
  return rows
    .filter((data) => requested.has(`t3_${String(data.id).toLowerCase()}`))
    .map((data) => ({ kind: 't3', data }));
}

export const MAX_AGGREGATE_CANDIDATES = 40;
export const MAX_COMMENT_AGGREGATES = 120 + MAX_AGGREGATE_CANDIDATES;
export const MAX_INDEXED_COMMENT_COUNT = 10_000_000;

export function aggregateTargets(
  candidates: RedditCandidate[],
  trackedIds: string[],
): string[] {
  const tracked = [...new Set(trackedIds)]
    .filter((id) => /^t3_[a-z0-9]+$/.test(id))
    .slice(0, 120);
  const trackedSet = new Set(tracked);
  // Samples do not determine who gets measured. Reserve room for ticker-specific topics,
  // and keep source diversity before using recency/relevance to fill the bounded shortlist.
  const ranked = candidates
    .filter((post) => !trackedSet.has(post.id))
    .sort(
      (a, b) =>
        beginnerFlairPenalty(b.flair) - beginnerFlairPenalty(a.flair) ||
        b.relevance - a.relevance ||
        b.createdAtUtc.localeCompare(a.createdAtUtc) ||
        a.id.localeCompare(b.id),
    );
  const selected = new Map<string, RedditCandidate>();
  const add = (post: RedditCandidate) => {
    if (selected.size < MAX_AGGREGATE_CANDIDATES) selected.set(post.id, post);
  };
  const tickerAuthors = new Map<string, number>();
  for (const post of ranked.filter(
    (post) => extractEtfTickers(post.title, post.body).length,
  )) {
    const author = post.author ?? '[deleted]';
    if ((tickerAuthors.get(author) ?? 0) >= 2) continue;
    add(post);
    tickerAuthors.set(author, (tickerAuthors.get(author) ?? 0) + 1);
    if (selected.size >= 20) break;
  }
  for (const subreddit of new Set(ranked.map((post) => post.subreddit)))
    ranked
      .filter((post) => post.subreddit === subreddit)
      .slice(0, 3)
      .forEach(add);
  ranked.forEach(add);
  return [...tracked, ...selected.keys()];
}

export async function fetchIndexedCommentCount(
  postId: string,
  fetcher: typeof fetch,
  now: () => number = Date.now,
): Promise<IndexedCommentObservation> {
  if (!/^t3_[a-z0-9]+$/.test(postId))
    throw new Error('Invalid aggregate post ID');
  const result = await requestRows(
    '/api/comments/search/aggregate',
    {
      link_id: postId,
      aggregate: 'subreddit',
      limit: '1',
    },
    fetcher,
  );
  if (result.length > 1) throw new RedditRssError('Invalid comment aggregate');
  const rawCount = result.length ? result[0].count : 0;
  if (
    (typeof rawCount !== 'number' && typeof rawCount !== 'string') ||
    (typeof rawCount === 'string' && !/^\d+$/.test(rawCount))
  )
    throw new RedditRssError('Invalid comment aggregate count');
  const count = Number(rawCount);
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_INDEXED_COMMENT_COUNT
  )
    throw new RedditRssError('Invalid comment aggregate count');
  return { count, observedAtUtc: new Date(now()).toISOString() };
}

export async function collectIndexedCommentCounts(
  candidates: RedditCandidate[],
  trackedIds: string[],
  details: SourceDetails,
  fetcher: typeof fetch,
  now: () => number = Date.now,
  maxDurationMs = 8 * 60_000,
): Promise<Map<string, IndexedCommentObservation>> {
  const targets = aggregateTargets(candidates, trackedIds);
  const counts = new Map<string, IndexedCommentObservation>();
  const deadline = now() + maxDurationMs;
  for (const id of targets) {
    if (now() >= deadline) break;
    try {
      counts.set(id, await fetchIndexedCommentCount(id, fetcher, now));
    } catch (error) {
      // A missing/error response is unknown, never zero. Preserve the existing cooldown.
      if (error instanceof RedditRssError && error.status === 429) throw error;
    }
  }
  details.commentMetric = 'indexed-total';
  details.aggregateRequested = targets.length;
  details.aggregateSucceeded = counts.size;
  if (counts.size < targets.length)
    details.warnings.push(
      `逐帖计数完成 ${counts.size}/${targets.length}；缺失计数不参与本轮榜单，也不视为零。`,
    );
  const measuredCandidates = candidates.filter((post) =>
    counts.has(post.id),
  ).length;
  if (candidates.length > measuredCandidates)
    details.warnings.push(
      `本轮 ${candidates.length} 篇候选中 ${measuredCandidates} 篇完成逐帖计数；新增候选计数上限 40，另行刷新全部追踪帖。`,
    );
  if (candidates.length && !measuredCandidates)
    throw new RedditRssError(
      'Arctic Shift candidate comment aggregates unavailable',
    );
  return counts;
}
