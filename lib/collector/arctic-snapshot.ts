import { normalizeIndexedPost, type SourceDetails } from './arctic-shift.ts';
import {
  DEFAULT_ETF_KEYWORDS,
  DEFAULT_SUBREDDITS,
  parseCsv,
  type RedditCandidate,
  type RawRedditPost,
} from './core.ts';
import type { RedditRssEnv } from './reddit-rss.ts';

export type ArcticSnapshot = {
  candidates: RedditCandidate[];
  trackedRaw: RawRedditPost[];
  commentCounts: Array<[string, number]>;
  details: SourceDetails;
};

// Both incoming text and numeric metadata remain untrusted even behind the ingest token.
export function parseArcticSnapshot(
  input: unknown,
  env: RedditRssEnv,
  now = Date.now(),
): ArcticSnapshot {
  if (!input || typeof input !== 'object')
    throw new Error('Invalid Arctic snapshot');
  const value = input as ArcticSnapshot;
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > 600 ||
    !Array.isArray(value.trackedRaw) ||
    value.trackedRaw.length > 120 ||
    !Array.isArray(value.commentCounts) ||
    value.commentCounts.length > 600
  )
    throw new Error('Invalid Arctic snapshot bounds');
  const allowed = new Set(
    parseCsv(env.REDDIT_SUBREDDITS, DEFAULT_SUBREDDITS)
      .slice(0, 6)
      .map((s) => s.toLowerCase()),
  );
  const keywords = parseCsv(env.ETF_KEYWORDS, DEFAULT_ETF_KEYWORDS);
  const counts = new Map<string, number>();
  let sampleSize = 0;
  for (const pair of value.commentCounts) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !/^t3_[a-z0-9]+$/.test(pair[0]) ||
      !Number.isInteger(pair[1]) ||
      pair[1] < 0 ||
      pair[1] > 600 ||
      counts.has(pair[0])
    )
      throw new Error('Invalid comment sample');
    counts.set(pair[0], pair[1]);
    sampleSize += pair[1];
  }
  if (sampleSize > 600) throw new Error('Comment sample exceeds source bound');
  const candidates: RedditCandidate[] = [];
  const seen = new Set<string>();
  for (const item of value.candidates) {
    if (
      !item ||
      typeof item.title !== 'string' ||
      item.title.length > 500 ||
      typeof item.body !== 'string' ||
      item.body.length > 4000 ||
      typeof item.subreddit !== 'string' ||
      !allowed.has(item.subreddit.toLowerCase())
    )
      throw new Error('Invalid indexed post');
    const created = Date.parse(item.createdAtUtc);
    if (
      !Number.isFinite(created) ||
      created < now - 25 * 3600000 ||
      created > now
    )
      throw new Error('Invalid post timestamp');
    const post = normalizeIndexedPost(
      {
        id: item.redditId,
        subreddit: item.subreddit,
        title: item.title,
        selftext: item.body,
        author: item.author,
        created_utc: created / 1000,
        permalink: item.permalink,
        url: item.outboundUrl,
        over_18: false,
        retrieved_on: item.indexedAtUtc
          ? Date.parse(item.indexedAtUtc) / 1000
          : undefined,
      },
      keywords,
    );
    if (!post || post.id !== item.id || seen.has(post.id))
      throw new Error('Invalid or duplicate indexed post');
    seen.add(post.id);
    candidates.push({ ...post, discussionCount: counts.get(post.id) ?? 0 });
  }
  const trackedRaw = value.trackedRaw.map((row) => {
    const data = row?.data;
    if (
      row?.kind !== 't3' ||
      !data ||
      typeof data.id !== 'string' ||
      !/^[a-z0-9]+$/i.test(data.id) ||
      typeof data.subreddit !== 'string' ||
      !allowed.has(data.subreddit.toLowerCase()) ||
      (typeof data.selftext === 'string' && data.selftext.length > 4000)
    )
      throw new Error('Invalid tracked post');
    return { kind: 't3', data };
  });
  const detail = value.details;
  if (
    !detail ||
    !Array.isArray(detail.communities) ||
    detail.communities.length > 6 ||
    !detail.communities.every(
      (s) => typeof s === 'string' && allowed.has(s.toLowerCase()),
    ) ||
    !Array.isArray(detail.warnings) ||
    detail.warnings.length > 20
  )
    throw new Error('Invalid source details');
  return {
    candidates,
    trackedRaw,
    commentCounts: [...counts],
    details: {
      provider: 'Arctic Shift (GitHub Actions)',
      communities: detail.communities,
      warnings: detail.warnings.map((s) => String(s).slice(0, 500)),
      newestPostAt:
        candidates
          .map((p) => p.createdAtUtc)
          .sort()
          .at(-1) ?? null,
      newestIndexedAt:
        candidates
          .map((p) => p.indexedAtUtc)
          .filter((s): s is string => Boolean(s))
          .sort()
          .at(-1) ?? null,
      commentSampleSize: sampleSize,
    },
  };
}
