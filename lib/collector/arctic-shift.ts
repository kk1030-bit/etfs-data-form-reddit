import {
  DEFAULT_ETF_KEYWORDS,
  DEFAULT_SUBREDDITS,
  normalizeRedditPost,
  parseCsv,
  type RawRedditPost,
  type RedditCandidate,
} from './core.ts';
import { RedditRssError, type RedditRssEnv } from './reddit-rss.ts';

const ORIGIN = 'https://arctic-shift.photon-reddit.com';
const MAX_BYTES = 2_000_000;
export type SourceDetails = {
  provider: string;
  communities: string[];
  warnings: string[];
  newestPostAt: string | null;
  newestIndexedAt: string | null;
  commentSampleSize: number;
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
      'User-Agent': 'etfs-hot-topics/0.2 (+private ETF research)',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429) {
    const resetAt = Number(response.headers.get('x-ratelimit-reset-at'));
    const seconds =
      response.headers.get('retry-after') ??
      response.headers.get('x-ratelimit-reset') ??
      (resetAt > Date.now()
        ? String(Math.ceil((resetAt - Date.now()) / 1000))
        : undefined);
    throw new RedditRssError('Arctic Shift rate limited', 429, seconds);
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
  return payload.data.filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
}

export async function fetchIndexedCandidates(
  env: RedditRssEnv,
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<{
  candidates: RedditCandidate[];
  details: SourceDetails;
  commentCounts: Map<string, number>;
}> {
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
  const commentIds = new Set<string>();
  for (const subreddit of communities) {
    try {
      const rows = await requestRows(
        '/api/posts/search',
        { subreddit, limit: '100', sort: 'desc', after, before },
        fetcher,
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
    await new Promise((resolve) => setTimeout(resolve, 550));
    try {
      const rows = await requestRows(
        '/api/comments/search',
        {
          subreddit,
          limit: '100',
          sort: 'desc',
          after,
          before,
          fields: 'id,link_id,created_utc,subreddit',
        },
        fetcher,
      );
      for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : '';
        const link = typeof row.link_id === 'string' ? row.link_id : '';
        if (!id || commentIds.has(id) || !/^(?:t3_)?[a-z0-9]+$/i.test(link))
          continue;
        if (String(row.subreddit).toLowerCase() !== subreddit.toLowerCase())
          continue;
        const created = Number(row.created_utc) * 1000;
        if (
          !Number.isFinite(created) ||
          created < Number(after) * 1000 ||
          created > nowMs
        )
          continue;
        commentIds.add(id);
        const postId = link.startsWith('t3_') ? link : `t3_${link}`;
        counts.set(postId, (counts.get(postId) ?? 0) + 1);
      }
    } catch (error) {
      if (error instanceof RedditRssError && error.status === 429) throw error;
      details.warnings.push(
        `r/${subreddit}：讨论样本暂缺，按时效和相关性排序。`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
  }
  if (!details.communities.length)
    throw new RedditRssError(
      `Arctic Shift 所有社区查询失败：${details.warnings.join(' ').slice(0, 1000)}`,
    );
  details.commentSampleSize = commentIds.size;
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
    { ids: safe.join(',') },
    fetcher,
  );
  const requested = new Set(safe.map((id) => id.toLowerCase()));
  return rows
    .filter((data) => requested.has(`t3_${String(data.id).toLowerCase()}`))
    .map((data) => ({ kind: 't3', data }));
}
