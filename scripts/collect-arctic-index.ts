import {
  createArcticFetcher,
  fetchIndexedCandidates,
  refreshIndexedPosts,
} from '../lib/collector/arctic-shift.ts';
import { RedditRssError } from '../lib/collector/reddit-rss.ts';
import { cleanRedditMarkdown } from '../lib/collector/core.ts';
import { diagnosticArcticFetcher } from './arctic-diagnostics.ts';
import { collectorExecutionContext } from './collector-execution-context.ts';

const executionContext = collectorExecutionContext();

const endpoint =
  'https://etfs-hot-topics.wangguancc.chatgpt.site/api/internal/arctic-index';
if (!process.env.TITLE_INGEST_TOKEN || !process.env.SITE_BYPASS_TOKEN)
  throw new Error('Collector secrets missing');
const headers = {
  Authorization: `Bearer ${process.env.TITLE_INGEST_TOKEN}`,
  'OAI-Sites-Authorization': `Bearer ${process.env.SITE_BYPASS_TOKEN}`,
  'X-Collector-Context': executionContext,
};
const preparation = await fetch(endpoint, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'prepare', executionContext }),
  redirect: 'manual',
  signal: AbortSignal.timeout(20000),
});
if (!preparation.ok)
  throw new Error(`Arctic preparation HTTP ${preparation.status}`);
console.log(JSON.stringify(await preparation.json()));
const stateResponse = await fetch(endpoint, {
  headers,
  redirect: 'manual',
  signal: AbortSignal.timeout(20000),
});
if (!stateResponse.ok)
  throw new Error(`Arctic state HTTP ${stateResponse.status}`);
const state = (await stateResponse.json()) as {
  needed: boolean;
  cooldownUntil?: string;
  scheduledAtMs: number;
  subreddits: string[];
  keywords: string[];
  trackedIds: string[];
};
if (!state.needed) {
  console.log(
    JSON.stringify({
      status: 'skipped',
      cooldownUntil: state.cooldownUntil ?? null,
    }),
  );
  process.exit(0);
}
let payload: object;
try {
  const paced = createArcticFetcher(
    process.env.ARCTIC_DIAGNOSTICS === '1' ? diagnosticArcticFetcher() : fetch,
  );
  const result = await fetchIndexedCandidates(
    {
      REDDIT_SUBREDDITS: state.subreddits.join(','),
      ETF_KEYWORDS: state.keywords.join(','),
    },
    fetch,
    state.scheduledAtMs,
    paced,
  );
  const trackedRaw = await refreshIndexedPosts(state.trackedIds, paced);
  payload = {
    scheduledAtMs: state.scheduledAtMs,
    executionContext,
    snapshot: {
      candidates: result.candidates.map((p) => ({
        ...p,
        body: p.body.slice(0, 4000),
      })),
      trackedRaw: trackedRaw.map((row) => ({
        ...row,
        data: {
          ...row.data,
          selftext:
            typeof row.data?.selftext === 'string'
              ? cleanRedditMarkdown(row.data.selftext, 4000)
              : '',
        },
      })),
      commentCounts: [...result.commentCounts],
      details: result.details,
    },
  };
} catch (error) {
  if (process.env.ARCTIC_DIAGNOSTICS === '1')
    console.log(
      JSON.stringify({
        collectionFailure:
          error instanceof Error ? error.message : String(error),
        upstreamStatus:
          error instanceof RedditRssError ? error.status : undefined,
      }),
    );
  payload = {
    scheduledAtMs: state.scheduledAtMs,
    executionContext,
    failure: {
      status: error instanceof RedditRssError ? error.status : undefined,
      retryAfter:
        error instanceof RedditRssError ? error.retryAfter : undefined,
    },
  };
}
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  redirect: 'manual',
  signal: AbortSignal.timeout(360000),
});
if (!response.ok) throw new Error(`Arctic ingestion HTTP ${response.status}`);
const result = (await response.json()) as {
  status: string;
  selected?: number;
  candidates?: number;
  retryAtUtc?: string;
};
console.log(
  JSON.stringify({
    status: result.status,
    selected: result.selected,
    candidates: result.candidates,
    retryAtUtc: result.retryAtUtc,
  }),
);
if (!['completed', 'skipped', 'cooldown', 'deferred'].includes(result.status))
  throw new Error('Arctic collection did not complete');
