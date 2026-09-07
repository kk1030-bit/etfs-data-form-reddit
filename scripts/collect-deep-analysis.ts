import {
  collectDeepDaily,
  type DeepAuthorCache,
} from '../lib/collector/deep-analysis-daily.ts';
import { RedditRssError } from '../lib/collector/reddit-rss.ts';

const endpoint =
  'https://etfs-hot-topics.wangguancc.chatgpt.site/api/internal/deep-analysis';
if (!process.env.TITLE_INGEST_TOKEN)
  throw new Error('Deep collector secret missing');
const headers: Record<string, string> = {
  Authorization: `Bearer ${process.env.TITLE_INGEST_TOKEN}`,
  'Content-Type': 'application/json',
};
if (process.env.SITE_BYPASS_TOKEN)
  headers['OAI-Sites-Authorization'] =
    `Bearer ${process.env.SITE_BYPASS_TOKEN}`;
async function site(input: unknown) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    redirect: 'manual',
    signal: AbortSignal.timeout(12 * 60000),
  });
  if (!response.ok) throw new Error(`Deep ingest HTTP ${response.status}`);
  return response.json();
}
const state = (await site({ action: 'begin' })) as {
  needed: boolean;
  day: string;
  token: string;
  scheduledAtMs: number;
  seenIds: string[];
  authors: DeepAuthorCache[];
};
if (!state.needed) {
  console.log(
    JSON.stringify({
      status: 'skipped',
      reason: 'Daily collection already attempted',
      day: state.day,
    }),
  );
} else {
  let requests = 0;
  let snapshot;
  try {
    const counted: typeof fetch = async (input, init) => {
      requests++;
      return fetch(input, init);
    };
    snapshot = await collectDeepDaily(state, counted, state.scheduledAtMs);
  } catch (error) {
    await site({
      action: 'failed',
      day: state.day,
      token: state.token,
      requests,
      upstreamStatus:
        error instanceof RedditRssError ? error.status : undefined,
      retryAfter:
        error instanceof RedditRssError ? error.retryAfter : undefined,
    });
    throw new Error(`Deep source collection failed after ${requests} requests`);
  }
  const result = (await site({
    action: 'ingest',
    day: state.day,
    token: state.token,
    snapshot,
  })) as {
    status: string;
    accepted: number;
    rejected: number;
    failed: number;
    requests: number;
  };
  console.log(JSON.stringify(result));
  if (result.status !== 'completed')
    throw new Error('Deep analysis partially failed; see run status');
}
