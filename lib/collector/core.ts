export const REDDIT_ORIGIN = 'https://www.reddit.com';
export const OAUTH_ORIGIN = 'https://oauth.reddit.com';
export const MAX_TRACKED_POSTS = 120;
export const D1_MAX_BOUND_PARAMETERS = 100;

export function clampRawRetentionHours(value?: string): number {
  const configured = Number(value ?? 48);
  const safeValue = Number.isFinite(configured) ? configured : 48;
  return Math.min(48, Math.max(24, Math.floor(safeValue)));
}

export function chunksForD1<T>(values: T[], parametersPerValue = 1): T[][] {
  if (!Number.isInteger(parametersPerValue) || parametersPerValue < 1) {
    throw new Error('parametersPerValue must be a positive integer');
  }
  const size = Math.floor(D1_MAX_BOUND_PARAMETERS / parametersPerValue);
  if (size < 1) throw new Error('A D1 row cannot exceed 100 bound parameters');
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function containsRedditUserHandle(value: string): boolean {
  return (
    /(\bu\/|@)[a-z0-9_-]{2,}/i.test(value) ||
    /reddit\.com\/(?:u|user)\/[a-z0-9_-]{2,}/i.test(value)
  );
}

export function safeReportTopicLabels(
  value: string,
  excludedAccounts: Array<string | null | undefined> = [],
): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const identities = excludedAccounts
      .filter((account): account is string => typeof account === 'string')
      .map((account) => account.trim().toLowerCase())
      .filter((account) => /^[a-z0-9_-]{2,}$/i.test(account));
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 40))
      .filter((item) => {
        const normalized = item.toLowerCase();
        return (
          item.length > 1 &&
          !containsRedditUserHandle(item) &&
          !/(?:https?:\/\/|www\.)/i.test(item) &&
          !identities.some((identity) => normalized.includes(identity))
        );
      });
  } catch {
    return [];
  }
}

export const TOP_STORIES_PER_HOUR = 5;
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export const DEFAULT_SUBREDDITS = [
  'ETFs',
  'investing',
  'Bogleheads',
  'stocks',
  'StockMarket',
  'dividends',
];

export const DEFAULT_ETF_KEYWORDS = [
  'etf',
  'exchange traded fund',
  'index fund',
  'asset allocation',
  'expense ratio',
  'tracking error',
  'voo',
  'vti',
  'vt',
  'spy',
  'qqq',
  'qqqm',
  'schd',
  'vxus',
  'bnd',
  'avuv',
  'iwm',
  'tlt',
  'sgov',
];

export type RawRedditPost = {
  kind?: string;
  data?: Record<string, unknown>;
};

export type RedditCandidate = {
  id: string;
  redditId: string;
  subreddit: string;
  author: string | null;
  permalink: string;
  outboundUrl: string | null;
  title: string;
  body: string;
  contentHash?: string;
  createdAtUtc: string;
  score: number;
  comments: number;
  upvoteRatio: number;
  bestListingRank: number | null;
  listingKinds: string[];
  relevance: number;
};

export type PreviousObservation = {
  score: number;
  comments: number;
  observedAtUtc: string;
};

export type ScoredCandidate = RedditCandidate & {
  heatScore: number;
  velocityScore: number;
  components: {
    velocity: number;
    engagement: number;
    listing: number;
    authorInfluence: number;
    relevance: number;
    freshness: number;
  };
  previousRank: number | null;
};

export type ReportWindow = {
  label: string;
  startUtc: string;
  endUtc: string;
};

function unknownString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function canonicalRedditPermalink(
  raw: string,
  expectedId: string,
): string | null {
  let url: URL;
  try {
    url = new URL(raw, REDDIT_ORIGIN);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['www.reddit.com', 'reddit.com'].includes(url.hostname.toLowerCase())
  ) {
    return null;
  }

  const decodedPath = safeDecodePath(url.pathname);
  const match = decodedPath.match(
    /^\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/[^/]*)?\/?$/i,
  );
  if (!match || match[2].toLowerCase() !== expectedId.toLowerCase()) {
    return null;
  }

  const subreddit = encodeURIComponent(match[1]);
  return `${REDDIT_ORIGIN}/r/${subreddit}/comments/${expectedId.toLowerCase()}/`;
}

export function cleanRedditMarkdown(
  value: unknown,
  maxLength = 14_000,
): string {
  if (typeof value !== 'string') return '';
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
      ? ''
      : character;
  }).join('');
  return withoutControls
    .replace(/<!--(?:.|\n)*?-->/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, maxLength);
}

function keywordPattern(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[a-z0-9]{2,5}$/i.test(keyword)
    ? new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i')
    : new RegExp(escaped, 'i');
}

export function calculateEtfRelevance(
  title: string,
  body: string,
  subreddit: string,
  keywords: string[] = DEFAULT_ETF_KEYWORDS,
): number {
  const haystack = `${title}\n${body.slice(0, 4_000)}`;
  const matches = keywords.reduce(
    (count, keyword) =>
      count + (keywordPattern(keyword).test(haystack) ? 1 : 0),
    0,
  );
  const explicitEtf = /\bETFs?\b|exchange[- ]traded fund/i.test(haystack);
  const subredditBoost = subreddit.toLowerCase() === 'etfs' ? 0.22 : 0;
  const base = explicitEtf ? 0.68 : matches > 0 ? 0.5 : 0;
  return clamp01(base + subredditBoost + Math.min(matches, 3) * 0.1);
}

export function normalizeRedditPost(
  child: RawRedditPost,
  listingKind: string,
  listingRank: number,
  keywords: string[] = DEFAULT_ETF_KEYWORDS,
): RedditCandidate | null {
  if (child.kind !== 't3' || !child.data) return null;
  const data = child.data;
  const redditId = unknownString(data.id).toLowerCase();
  if (!/^[a-z0-9]+$/.test(redditId)) return null;

  const permalink = canonicalRedditPermalink(
    unknownString(data.permalink),
    redditId,
  );
  if (!permalink) return null;

  if (
    data.promoted ||
    data.over_18 ||
    data.quarantine ||
    data.stickied ||
    data.removed_by_category ||
    data.author === '[deleted]'
  ) {
    return null;
  }

  const title = cleanRedditMarkdown(data.title, 500);
  const body = cleanRedditMarkdown(data.selftext);
  if (!title || body === '[deleted]' || body === '[removed]') return null;

  const subreddit = cleanRedditMarkdown(data.subreddit, 80);
  const relevance = calculateEtfRelevance(title, body, subreddit, keywords);
  if (relevance < 0.65) return null;

  const createdSeconds = finiteNumber(data.created_utc);
  if (createdSeconds <= 0) return null;

  const outbound = typeof data.url === 'string' ? data.url : null;
  const isSelf = Boolean(data.is_self);

  return {
    id: `t3_${redditId}`,
    redditId,
    subreddit,
    author:
      typeof data.author === 'string'
        ? cleanRedditMarkdown(data.author, 80)
        : null,
    permalink,
    outboundUrl: isSelf || outbound === permalink ? null : outbound,
    title,
    body,
    createdAtUtc: new Date(createdSeconds * 1_000).toISOString(),
    score: Math.trunc(finiteNumber(data.score)),
    comments: Math.max(0, Math.trunc(finiteNumber(data.num_comments))),
    upvoteRatio: clamp01(finiteNumber(data.upvote_ratio, 0.5)),
    bestListingRank: listingRank,
    listingKinds: [listingKind],
    relevance,
  };
}

export function mergeCandidate(
  existing: RedditCandidate | undefined,
  incoming: RedditCandidate,
): RedditCandidate {
  if (!existing) return incoming;
  return {
    ...existing,
    score: incoming.score,
    comments: incoming.comments,
    upvoteRatio: incoming.upvoteRatio,
    bestListingRank:
      existing.bestListingRank === null
        ? incoming.bestListingRank
        : incoming.bestListingRank === null
          ? existing.bestListingRank
          : Math.min(existing.bestListingRank, incoming.bestListingRank),
    listingKinds: Array.from(
      new Set([...existing.listingKinds, ...incoming.listingKinds]),
    ),
    relevance: Math.max(existing.relevance, incoming.relevance),
  };
}

function percentileRanks(values: number[]): number[] {
  if (values.length <= 1) return values.map(() => 1);
  const indexed = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const result = Array.from<number>({ length: values.length });
  indexed.forEach((entry, rank) => {
    result[entry.index] = rank / (values.length - 1);
  });
  return result;
}

export function scoreCandidates(
  candidates: RedditCandidate[],
  observedAtMs: number,
  previous: Map<string, PreviousObservation> = new Map(),
  authorInfluence: Map<string, number> = new Map(),
  previousRanks: Map<string, number> = new Map(),
): ScoredCandidate[] {
  const rawVelocity = candidates.map((candidate) => {
    const prior = previous.get(candidate.id);
    const ageHours = Math.max(
      (observedAtMs - Date.parse(candidate.createdAtUtc)) / 3_600_000,
      0.25,
    );
    if (!prior)
      return Math.log1p(
        (Math.max(candidate.score, 0) + candidate.comments * 2) / ageHours,
      );
    const elapsed = Math.max(
      (observedAtMs - Date.parse(prior.observedAtUtc)) / 3_600_000,
      0.25,
    );
    const delta =
      Math.max(candidate.score - prior.score, 0) +
      Math.max(candidate.comments - prior.comments, 0) * 2;
    return Math.log1p(delta / elapsed);
  });
  const rawEngagement = candidates.map((candidate) =>
    Math.log1p(Math.max(candidate.score, 0) + candidate.comments * 2),
  );
  const velocityRanks = percentileRanks(rawVelocity);
  const engagementRanks = percentileRanks(rawEngagement);

  return candidates
    .map((candidate, index) => {
      const ageHours = Math.max(
        (observedAtMs - Date.parse(candidate.createdAtUtc)) / 3_600_000,
        0,
      );
      const components = {
        velocity: velocityRanks[index],
        engagement: engagementRanks[index],
        listing: candidate.bestListingRank
          ? clamp01(1 - (candidate.bestListingRank - 1) / 50)
          : 0,
        authorInfluence: clamp01(
          authorInfluence.get(candidate.author ?? '') ?? 0.5,
        ),
        relevance: clamp01(candidate.relevance),
        freshness: Math.exp(-ageHours / 24),
      };
      const heatScore =
        100 *
        (0.3 * components.velocity +
          0.22 * components.engagement +
          0.15 * components.listing +
          0.13 * components.authorInfluence +
          0.12 * components.relevance +
          0.08 * components.freshness);
      return {
        ...candidate,
        heatScore: Math.round(heatScore * 10) / 10,
        velocityScore: Math.round(rawVelocity[index] * 1_000) / 1_000,
        components,
        previousRank: previousRanks.get(candidate.id) ?? null,
      };
    })
    .sort(
      (a, b) =>
        b.heatScore - a.heatScore ||
        b.comments - a.comments ||
        b.score - a.score ||
        Date.parse(b.createdAtUtc) - Date.parse(a.createdAtUtc) ||
        a.id.localeCompare(b.id),
    );
}

export function selectTopStories(
  ranked: ScoredCandidate[],
  limit = TOP_STORIES_PER_HOUR,
): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  const authors = new Map<string, number>();
  const subreddits = new Map<string, number>();

  for (const candidate of ranked) {
    const author = candidate.author ?? '[deleted]';
    const authorCount = authors.get(author) ?? 0;
    const subredditCount = subreddits.get(candidate.subreddit) ?? 0;
    if (authorCount >= 2 || subredditCount >= 3) continue;
    selected.push(candidate);
    authors.set(author, authorCount + 1);
    subreddits.set(candidate.subreddit, subredditCount + 1);
    if (selected.length === limit) return selected;
  }

  for (const candidate of ranked) {
    if (selected.some((story) => story.id === candidate.id)) continue;
    if ((authors.get(candidate.author ?? '[deleted]') ?? 0) >= 2) continue;
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}

export function logicalHourIso(timestampMs: number): string {
  const date = new Date(timestampMs);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function isoDateFromShifted(timestampMs: number): string {
  return new Date(timestampMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function utcFromBeijingDate(dateLabel: string): number {
  const [year, month, day] = dateLabel.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS;
}

export function previousBeijingDayWindow(scheduledAtMs: number): ReportWindow {
  const todayLabel = isoDateFromShifted(scheduledAtMs);
  const endMs = utcFromBeijingDate(todayLabel);
  const startMs = endMs - 24 * 60 * 60 * 1_000;
  return {
    label: isoDateFromShifted(startMs),
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
  };
}

export function previousBeijingWeekWindow(scheduledAtMs: number): ReportWindow {
  const shifted = new Date(scheduledAtMs + BEIJING_OFFSET_MS);
  const day = shifted.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const localMidnightMs =
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - BEIJING_OFFSET_MS;
  const currentMondayMs =
    localMidnightMs - daysSinceMonday * 24 * 60 * 60 * 1_000;
  const startMs = currentMondayMs - 7 * 24 * 60 * 60 * 1_000;
  return {
    label: isoDateFromShifted(startMs),
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(currentMondayMs).toISOString(),
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function parseCsv(
  value: string | undefined,
  fallback: string[],
): string[] {
  const parsed = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? Array.from(new Set(parsed)) : fallback;
}
