import { arcticRetryAfter, createArcticFetcher } from './arctic-shift.ts';
import { RedditRssError } from './reddit-rss.ts';

export const DEEP_COMMUNITIES = [
  'Bogleheads',
  'ETFs',
  'LETFs',
  'investing',
  'SecurityAnalysis',
  'bonds',
  'factorinvesting',
] as const;
export const BACKFILL_COMMUNITIES = [
  'Bogleheads',
  'LETFs',
  'SecurityAnalysis',
] as const;
export const DEEP_POST_FIELDS = [
  'id',
  'title',
  'author',
  'created_utc',
  'selftext',
  'link_flair_text',
  'author_flair_text',
  'is_self',
  'domain',
  'url',
  'over_18',
  'retrieved_on',
] as const;
export type DeepPost = { subreddit: string } & Record<
  (typeof DEEP_POST_FIELDS)[number],
  unknown
>;

export type BackfillCommunity = {
  subreddit: string;
  returned: number;
  unique: number;
  oldest: string | null;
  newest: string | null;
  flairs: Array<{ flair: string; count: number }>;
};
export type DeepBackfill = {
  fetchedAt: string;
  window: '30d';
  requests: number;
  communities: BackfillCommunity[];
  posts: DeepPost[];
};

export async function collectDeepBackfill(
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<DeepBackfill> {
  const request = createArcticFetcher(fetcher);
  const result: DeepBackfill = {
    fetchedAt: new Date(now).toISOString(),
    window: '30d',
    requests: 0,
    communities: [],
    posts: [],
  };
  const seen = new Set<string>();
  for (const subreddit of BACKFILL_COMMUNITIES) {
    const url = new URL(
      'https://arctic-shift.photon-reddit.com/api/posts/search',
    );
    // The live API rejects is_self in fields; the full response includes it.
    // Select only the requested fields locally, never infer self posts from URLs.
    url.search = new URLSearchParams({
      subreddit,
      after: '30d',
      limit: 'auto',
      sort: 'desc',
    }).toString();
    result.requests++;
    const response = await request(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'etfs-hot-topics/0.4 (+https://github.com/kk1030-bit/etfs-data-form-reddit)',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new RedditRssError(
        `Deep backfill r/${subreddit}: HTTP ${response.status}`,
        response.status,
        arcticRetryAfter(response.headers),
      );
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('Backfill response is not JSON');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Backfill response is empty');
    const decoder = new TextDecoder();
    let body = '';
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_000_000) {
        await reader.cancel();
        throw new Error('Backfill exceeds 16 MB response bound');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const payload = JSON.parse(body) as { data?: unknown };
    if (!Array.isArray(payload.data) || payload.data.length > 1000)
      throw new Error('Invalid backfill response');
    const flairs = new Map<string, number>();
    const timestamps: number[] = [];
    let unique = 0;
    for (const item of payload.data) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('Invalid backfill post');
      const row = item as Record<string, unknown>;
      if (
        typeof row.id !== 'string' ||
        !/^[a-z0-9]+$/i.test(row.id) ||
        typeof row.subreddit !== 'string' ||
        row.subreddit.toLowerCase() !== subreddit.toLowerCase()
      )
        throw new Error('Backfill source mismatch');
      const created =
        typeof row.created_utc === 'number' ? row.created_utc * 1000 : NaN;
      if (
        !Number.isFinite(created) ||
        created < now - 30 * 86400000 ||
        created > Date.now() + 60000
      )
        throw new Error('Backfill timestamp outside requested window');
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      unique++;
      timestamps.push(created);
      const flair =
        typeof row.link_flair_text === 'string' && row.link_flair_text.trim()
          ? row.link_flair_text.trim()
          : '(无 flair)';
      flairs.set(flair, (flairs.get(flair) ?? 0) + 1);
      const post = { subreddit } as DeepPost;
      for (const field of DEEP_POST_FIELDS) post[field] = row[field] ?? null;
      result.posts.push(post);
    }
    result.communities.push({
      subreddit,
      returned: payload.data.length,
      unique,
      oldest: timestamps.length
        ? new Date(Math.min(...timestamps)).toISOString()
        : null,
      newest: timestamps.length
        ? new Date(Math.max(...timestamps)).toISOString()
        : null,
      flairs: [...flairs]
        .map(([flair, count]) => ({ flair, count }))
        .sort((a, b) => b.count - a.count || a.flair.localeCompare(b.flair)),
    });
  }
  return result;
}
