import { arcticRetryAfter, createArcticFetcher } from './arctic-shift.ts';
import { RedditRssError } from './reddit-rss.ts';
import {
  DEEP_COMMUNITIES,
  DEEP_POST_FIELDS,
  type DeepPost,
} from './deep-analysis-source.ts';
import { scoreDeepAnalysis } from './deep-analysis.ts';
import { compareDeepRecent, deepPublishedMs } from './deep-analysis-dates.ts';

export type DeepAuthorCache = {
  author: string;
  longPosts: number;
  checkedAt: string;
};
export type DeepFinalist = {
  post: DeepPost;
  uniqueCommenters: number | null;
  authorLongPosts: number | null;
};
export type DeepDailySnapshot = {
  collectedAt: string;
  requests: number;
  communities: Array<{ subreddit: string; returned: number }>;
  seenIds: string[];
  authors: DeepAuthorCache[];
  finalists: DeepFinalist[];
};

export function deepSupplementPoints(
  uniqueCommenters: number | null,
  authorLongPosts: number | null,
) {
  return {
    commenters:
      uniqueCommenters === null
        ? 0
        : Math.min(10, Math.log2(1 + uniqueCommenters)),
    authorHistory:
      authorLongPosts === null ? 0 : Math.min(10, authorLongPosts * 2),
  };
}

/** Seven serial searches, then at most two supplemental searches per finalist. No retries. */
export async function collectDeepDaily(
  state: { seenIds: string[]; authors: DeepAuthorCache[] },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  sleep?: (ms: number) => Promise<void>,
): Promise<DeepDailySnapshot> {
  const result: DeepDailySnapshot = {
    collectedAt: new Date(now).toISOString(),
    requests: 0,
    communities: [],
    seenIds: [],
    authors: [],
    finalists: [],
  };
  const paced = createArcticFetcher(fetcher, sleep);
  const request = async (
    path: string,
    params: Record<string, string>,
    maxRows: number,
  ) => {
    if (result.requests >= 25)
      throw new Error('Deep daily request budget reached');
    result.requests++;
    const url = new URL(path, 'https://arctic-shift.photon-reddit.com');
    url.search = new URLSearchParams(params).toString();
    const response = await paced(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'etfs-hot-topics-deep/1.0 (+https://github.com/kk1030-bit/etfs-data-form-reddit)',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new RedditRssError(
        `Deep source HTTP ${response.status}`,
        response.status,
        arcticRetryAfter(response.headers),
      );
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('Deep source is not JSON');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Deep source is empty');
    const decoder = new TextDecoder();
    let bytes = 0,
      text = '';
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16_000_000) {
        await reader.cancel();
        throw new Error('Deep response too large');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const data = (JSON.parse(text) as { data?: unknown }).data;
    if (
      !Array.isArray(data) ||
      data.length > maxRows ||
      data.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    )
      throw new Error('Invalid deep source response');
    return data as Record<string, unknown>[];
  };
  const seen = new Set(state.seenIds);
  const candidates: Array<{
    post: DeepPost;
    id: string;
    publishedAt: string;
    score: number;
  }> = [];
  for (const subreddit of DEEP_COMMUNITIES) {
    // API rejects is_self/domain in field projection. Retain only specified fields locally.
    const data = await request(
      '/api/posts/search',
      { subreddit, after: '72h', limit: 'auto', sort: 'desc' },
      1000,
    );
    result.communities.push({ subreddit, returned: data.length });
    for (const row of data) {
      if (
        typeof row.id !== 'string' ||
        !/^[a-z0-9]{1,16}$/.test(row.id) ||
        String(row.subreddit).toLowerCase() !== subreddit.toLowerCase()
      )
        throw new Error('Deep source mismatch');
      const published = deepPublishedMs(row.created_utc, now);
      // Never substitute retrieval time; reject malformed, future, or stale publication dates.
      if (
        published === null ||
        published < now - 72 * 3600000 ||
        seen.has(row.id)
      )
        continue;
      seen.add(row.id);
      const post = { subreddit } as DeepPost;
      for (const field of DEEP_POST_FIELDS) post[field] = row[field] ?? null;
      const scored = scoreDeepAnalysis(post, 'reject-matched');
      if (!scored.finalist) {
        result.seenIds.push(row.id);
        continue;
      }
      candidates.push({
        post,
        id: row.id,
        publishedAt: new Date(published).toISOString(),
        score: scored.score,
      });
    }
  }
  const cache = new Map(
    state.authors
      .filter(
        (a) =>
          Date.parse(a.checkedAt) > now - 7 * 86400000 &&
          Date.parse(a.checkedAt) <= now,
      )
      .map((a) => [a.author.toLowerCase(), a]),
  );
  // Qualified overflow is left unseen so tomorrow's 72h search can still consider it.
  for (const { post, id } of candidates.sort(compareDeepRecent).slice(0, 8)) {
    let uniqueCommenters: number | null = null;
    let authorLongPosts: number | null = null;
    try {
      const groups = await request(
        '/api/comments/search/aggregate',
        { aggregate: 'author', link_id: `t3_${id}`, limit: '' },
        100000,
      );
      if (
        groups.some(
          (g) =>
            (g.author !== null && typeof g.author !== 'string') ||
            (typeof g.count !== 'number' &&
              !(typeof g.count === 'string' && /^\d+$/.test(g.count))) ||
            !Number.isSafeInteger(Number(g.count)) ||
            Number(g.count) < 0,
        )
      )
        throw new Error('Invalid commenter aggregation');
      uniqueCommenters = new Set(
        groups
          .filter((g) => typeof g.author === 'string' && g.author.trim())
          .map((g) => String(g.author).toLowerCase())
          .filter(
            (a) =>
              a !== '[deleted]' && a !== '[removed]' && a !== 'automoderator',
          ),
      ).size;
      const author = typeof post.author === 'string' ? post.author : '';
      if (/^[A-Za-z0-9_-]{1,32}$/.test(author)) {
        let entry = cache.get(author.toLowerCase());
        if (!entry) {
          const history = await request(
            '/api/posts/search',
            {
              author,
              subreddit: DEEP_COMMUNITIES.join(','),
              after: '90d',
              limit: '50',
              fields: 'id,subreddit,created_utc,selftext',
            },
            50,
          );
          const ids = new Set<string>();
          for (const item of history) {
            const created =
              typeof item.created_utc === 'number'
                ? item.created_utc * 1000
                : NaN;
            if (
              typeof item.id === 'string' &&
              DEEP_COMMUNITIES.some(
                (c) => c.toLowerCase() === String(item.subreddit).toLowerCase(),
              ) &&
              created >= now - 90 * 86400000 &&
              created <= now &&
              typeof item.selftext === 'string' &&
              Array.from(item.selftext.trim()).length >= 1500
            )
              ids.add(item.id);
          }
          entry = {
            author,
            longPosts: ids.size,
            checkedAt: new Date(now).toISOString(),
          };
          cache.set(author.toLowerCase(), entry);
          result.authors.push(entry);
        }
        authorLongPosts = entry.longPosts;
      }
    } catch (error) {
      // A global rate limit stops the run; never disguise it as zero discussion.
      if (error instanceof RedditRssError && error.status === 429) throw error;
      // Missing supplemental metrics stay null, not fabricated zeroes.
    }
    result.finalists.push({ post, uniqueCommenters, authorLongPosts });
    result.seenIds.push(id);
  }
  return result;
}
