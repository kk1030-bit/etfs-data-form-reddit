import {
  calculateEtfRelevance,
  canonicalRedditPermalink,
  cleanRedditMarkdown,
  DEFAULT_ETF_KEYWORDS,
  DEFAULT_SUBREDDITS,
  parseCsv,
  REDDIT_ORIGIN,
  type RedditCandidate,
} from './core.ts';

const MAX_RSS_BYTES = 1_000_000;
const MAX_RSS_ENTRIES = 100;
const SUBREDDIT_PATTERN = /^[A-Za-z0-9_]{2,21}$/;

export type RedditRssEnv = {
  REDDIT_USER_AGENT?: string;
  REDDIT_SUBREDDITS?: string;
  REDDIT_RSS_SORT?: string;
  ETF_KEYWORDS?: string;
};

export class RedditRssError extends Error {
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(message: string, status?: number, retryAfter?: string) {
    super(message);
    this.name = 'RedditRssError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function rssSort(value?: string): 'hot' | 'top' {
  return value?.trim().toLowerCase() === 'top' ? 'top' : 'hot';
}

function allowedSubreddits(env: RedditRssEnv): string[] {
  const values = parseCsv(env.REDDIT_SUBREDDITS, DEFAULT_SUBREDDITS)
    .filter((value) => SUBREDDIT_PATTERN.test(value))
    .slice(0, 12);
  if (!values.length) throw new RedditRssError('RSS 社区白名单为空或格式无效');
  return values;
}

export function buildRedditRssUrl(env: RedditRssEnv): URL {
  const sort = rssSort(env.REDDIT_RSS_SORT);
  const joined = allowedSubreddits(env).map(encodeURIComponent).join('+');
  const url = new URL(`/r/${joined}/${sort}/.rss`, REDDIT_ORIGIN);
  url.searchParams.set('limit', String(MAX_RSS_ENTRIES));
  if (sort === 'top') url.searchParams.set('t', 'day');
  return url;
}

function decodeXmlEntitiesOnce(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, key: string) => {
      if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
      const codePoint =
        key[1]?.toLowerCase() === 'x'
          ? Number.parseInt(key.slice(2), 16)
          : Number.parseInt(key.slice(1), 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff
      ) {
        return '';
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return '';
      }
    },
  );
}

function decodeXmlText(value: string): string {
  const withoutCdata = value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1');
  return decodeXmlEntitiesOnce(decodeXmlEntitiesOnce(withoutCdata));
}

function extractTag(value: string, tag: string): string {
  const match = value.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  return match?.[1] ?? '';
}

function extractAttribute(value: string, name: string): string {
  const match = value.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'),
  );
  return decodeXmlText(match?.[1] ?? match?.[2] ?? '');
}

function htmlToText(value: string): string {
  const decoded = decodeXmlText(value)
    .replace(/<!--(?:.|\n)*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|div|blockquote|h[1-6])\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  return cleanRedditMarkdown(
    decodeXmlText(decoded)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' '),
    6_000,
  );
}

function entryPermalink(entry: string, redditId: string): string | null {
  const linkTags = entry.match(/<link\b[^>]*\/?\s*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = extractAttribute(tag, 'rel').toLowerCase();
    if (rel && rel !== 'alternate') continue;
    const canonical = canonicalRedditPermalink(
      extractAttribute(tag, 'href'),
      redditId,
    );
    if (canonical) return canonical;
  }
  return null;
}

function entryBody(entry: string): string {
  const html = decodeXmlText(extractTag(entry, 'content'));
  const markdown = html.match(
    /<div\b[^>]*class=(?:"[^"]*\bmd\b[^"]*"|'[^']*\bmd\b[^']*')[^>]*>([\s\S]*?)<\/div>/i,
  );
  return markdown ? htmlToText(markdown[1]) : '';
}

function entrySubreddit(entry: string): string {
  const category = entry.match(/<category\b[^>]*\/?\s*>/i)?.[0] ?? '';
  return cleanRedditMarkdown(extractAttribute(category, 'term'), 80);
}

export function parseRedditAtomFeed(
  xml: string,
  keywords: string[] = DEFAULT_ETF_KEYWORDS,
  sort: 'hot' | 'top' = 'hot',
): RedditCandidate[] {
  if (
    !/<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xml)
  ) {
    throw new RedditRssError('Reddit RSS 回应不是 Atom feed');
  }
  const entries = (xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) ?? []).slice(
    0,
    MAX_RSS_ENTRIES,
  );
  if (!entries.length) throw new RedditRssError('Reddit RSS 没有任何 entry');

  const results = new Map<string, RedditCandidate>();
  entries.forEach((entry, index) => {
    const idMatch = decodeXmlText(extractTag(entry, 'id'))
      .trim()
      .match(/^t3_([a-z0-9]+)$/i);
    if (!idMatch) return;
    const redditId = idMatch[1].toLowerCase();
    const permalink = entryPermalink(entry, redditId);
    if (!permalink) return;

    const title = cleanRedditMarkdown(
      htmlToText(extractTag(entry, 'title')),
      500,
    );
    const author = cleanRedditMarkdown(
      decodeXmlText(extractTag(extractTag(entry, 'author'), 'name')).replace(
        /^\/?u\//i,
        '',
      ),
      80,
    );
    const subreddit = entrySubreddit(entry);
    const published = decodeXmlText(
      extractTag(entry, 'published') || extractTag(entry, 'updated'),
    );
    const createdAtMs = Date.parse(published);
    if (
      !title ||
      !subreddit ||
      !Number.isFinite(createdAtMs) ||
      !author ||
      /^AutoModerator$/i.test(author) ||
      author === '[deleted]'
    ) {
      return;
    }

    const body = entryBody(entry);
    const relevance = calculateEtfRelevance(title, body, subreddit, keywords);
    if (relevance < 0.65) return;
    const candidate: RedditCandidate = {
      id: `t3_${redditId}`,
      redditId,
      subreddit,
      author,
      permalink,
      outboundUrl: null,
      title,
      body,
      createdAtUtc: new Date(createdAtMs).toISOString(),
      score: 0,
      comments: 0,
      upvoteRatio: 0.5,
      metricsAvailable: false,
      bestListingRank: index + 1,
      listingKinds: [`rss-${sort}`],
      relevance,
    };
    if (!results.has(candidate.id)) results.set(candidate.id, candidate);
  });
  return [...results.values()];
}

function validateRssUrl(value: string | URL, expected: URL): URL {
  const finalUrl = new URL(value);
  if (
    finalUrl.protocol !== 'https:' ||
    (finalUrl.port !== '' && finalUrl.port !== '443') ||
    finalUrl.username !== '' ||
    finalUrl.password !== '' ||
    !['www.reddit.com', 'reddit.com'].includes(
      finalUrl.hostname.toLowerCase(),
    ) ||
    finalUrl.pathname !== expected.pathname ||
    finalUrl.searchParams.get('limit') !== expected.searchParams.get('limit') ||
    finalUrl.searchParams.get('t') !== expected.searchParams.get('t')
  ) {
    throw new RedditRssError('Reddit RSS redirect target validation failed');
  }
  return finalUrl;
}

export async function fetchRedditRssCandidates(
  env: RedditRssEnv,
  fetcher: typeof fetch = fetch,
): Promise<RedditCandidate[]> {
  const url = buildRedditRssUrl(env);
  let requestUrl = validateRssUrl(url, url);
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 2; redirectCount += 1) {
    response = await fetcher(requestUrl, {
      headers: {
        Accept: 'application/atom+xml, application/xml;q=0.9',
        'User-Agent':
          env.REDDIT_USER_AGENT ?? 'etfs-hot-topics-rss-preview/0.1',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.url) validateRssUrl(response.url, url);
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location || redirectCount === 2) {
      throw new RedditRssError('Reddit RSS redirect validation failed');
    }
    requestUrl = validateRssUrl(new URL(location, requestUrl), url);
    response = null;
  }
  if (!response) throw new RedditRssError('Reddit RSS redirect failed');
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    throw new RedditRssError(
      `Reddit RSS rate limited${retryAfter ? `; retry-after=${retryAfter}` : ''}`,
      429,
      retryAfter,
    );
  }
  if (!response.ok) {
    throw new RedditRssError(`Reddit RSS ${response.status}`, response.status);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/(?:application\/(?:atom\+xml|xml)|text\/xml)/.test(contentType)) {
    throw new RedditRssError(
      `Reddit RSS content-type 无效: ${contentType || 'missing'}`,
    );
  }
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RSS_BYTES) {
    throw new RedditRssError('Reddit RSS 回应超过 1 MB 上限');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RSS_BYTES) {
    throw new RedditRssError('Reddit RSS 回应超过 1 MB 上限');
  }
  const candidates = parseRedditAtomFeed(
    new TextDecoder().decode(bytes),
    parseCsv(env.ETF_KEYWORDS, DEFAULT_ETF_KEYWORDS),
    rssSort(env.REDDIT_RSS_SORT),
  );
  if (!candidates.length) {
    throw new RedditRssError('Reddit RSS 没有符合 ETF 条件的候选帖子');
  }
  return candidates;
}
