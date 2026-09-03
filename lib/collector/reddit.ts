import {
  DEFAULT_ETF_KEYWORDS,
  DEFAULT_SUBREDDITS,
  mergeCandidate,
  normalizeRedditPost,
  OAUTH_ORIGIN,
  parseCsv,
  type RawRedditPost,
  type RedditCandidate,
} from './core.ts';
import { fetchRedditRssCandidates, type RedditRssEnv } from './reddit-rss.ts';

export type RedditSourceMode = 'rss-preview' | 'oauth';

export type RedditEnv = RedditRssEnv & {
  REDDIT_SOURCE_MODE?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
};

type ListingResponse = {
  data?: {
    children?: RawRedditPost[];
    after?: string | null;
  };
};

type OAuthResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

export type RedditSession = {
  mode: RedditSourceMode;
  userAgent: string;
  token?: string;
};

export function redditSourceMode(env: RedditEnv): RedditSourceMode {
  return env.REDDIT_SOURCE_MODE?.trim().toLowerCase() === 'oauth'
    ? 'oauth'
    : 'rss-preview';
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少必要环境变量 ${name}`);
  return value;
}

export async function createRedditSession(
  env: RedditEnv,
): Promise<RedditSession> {
  const mode = redditSourceMode(env);
  if (mode === 'rss-preview') {
    return {
      mode,
      userAgent: env.REDDIT_USER_AGENT ?? 'etfs-hot-topics-rss-preview/0.1',
    };
  }
  const clientId = required(env.REDDIT_CLIENT_ID, 'REDDIT_CLIENT_ID');
  const clientSecret = required(
    env.REDDIT_CLIENT_SECRET,
    'REDDIT_CLIENT_SECRET',
  );
  const userAgent = required(env.REDDIT_USER_AGENT, 'REDDIT_USER_AGENT');
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json()) as OAuthResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Reddit OAuth 失败 (${response.status}): ${payload.error ?? 'missing access_token'}`,
    );
  }
  return { mode, token: payload.access_token, userAgent };
}

async function redditGet<T>(session: RedditSession, path: string): Promise<T> {
  if (session.mode !== 'oauth' || !session.token) {
    throw new Error('Reddit OAuth session required');
  }
  const url = new URL(path, OAUTH_ORIGIN);
  if (url.origin !== OAUTH_ORIGIN)
    throw new Error('Reddit API host validation failed');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${session.token}`,
      'User-Agent': session.userAgent,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 429) {
    const reset = response.headers.get('x-ratelimit-reset') ?? 'unknown';
    throw new Error(`Reddit API rate limited; reset=${reset}s`);
  }
  if (!response.ok)
    throw new Error(`Reddit API ${response.status} for ${url.pathname}`);
  return (await response.json()) as T;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await task(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function discoverRedditCandidates(
  env: RedditEnv,
  providedSession?: RedditSession,
): Promise<RedditCandidate[]> {
  const session = providedSession ?? (await createRedditSession(env));
  if (session.mode === 'rss-preview') return fetchRedditRssCandidates(env);
  const subreddits = parseCsv(env.REDDIT_SUBREDDITS, DEFAULT_SUBREDDITS).slice(
    0,
    8,
  );
  const keywords = parseCsv(env.ETF_KEYWORDS, DEFAULT_ETF_KEYWORDS);
  const listings = ['hot', 'rising', 'top?t=hour'] as const;
  const jobs = subreddits.flatMap((subreddit) =>
    listings.map((listing) => ({ subreddit, listing })),
  );

  const payloads = await mapWithConcurrency(
    jobs,
    4,
    async ({ subreddit, listing }) => {
      const separator = listing.includes('?') ? '&' : '?';
      const path = `/r/${encodeURIComponent(subreddit)}/${listing}${separator}limit=40&raw_json=1`;
      return {
        subreddit,
        listing: listing.split('?')[0],
        payload: await redditGet<ListingResponse>(session, path),
      };
    },
  );

  const merged = new Map<string, RedditCandidate>();
  for (const { listing, payload } of payloads) {
    const children = payload.data?.children ?? [];
    children.forEach((child, index) => {
      const candidate = normalizeRedditPost(
        child,
        listing,
        index + 1,
        keywords,
      );
      if (candidate)
        merged.set(
          candidate.id,
          mergeCandidate(merged.get(candidate.id), candidate),
        );
    });
  }
  return [...merged.values()];
}

export async function refreshTrackedPosts(
  env: RedditEnv,
  postIds: string[],
  providedSession?: RedditSession,
): Promise<RawRedditPost[]> {
  const session = providedSession ?? (await createRedditSession(env));
  if (session.mode !== 'oauth') return [];
  const ids = Array.from(
    new Set(postIds.filter((id) => /^t3_[a-z0-9]+$/i.test(id))),
  );
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 100)
    chunks.push(ids.slice(index, index + 100));
  const responses = await mapWithConcurrency(chunks, 2, (chunk) =>
    redditGet<ListingResponse>(
      session,
      `/api/info?id=${encodeURIComponent(chunk.join(','))}&raw_json=1`,
    ),
  );
  return responses.flatMap((payload) => payload.data?.children ?? []);
}
