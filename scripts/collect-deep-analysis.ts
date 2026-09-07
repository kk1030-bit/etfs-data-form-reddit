import {
  collectDeepDaily,
  type DeepAuthorCache,
} from '../lib/collector/deep-analysis-daily.ts';
import { RedditRssError } from '../lib/collector/reddit-rss.ts';
import {
  newWorkflowMetrics,
  observeArctic,
  writeWorkflowSummary,
} from './workflow-summary.ts';

const metrics = newWorkflowMetrics();
async function collect() {
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
    metrics.status = 'skipped';
    metrics.reason = '当天已经执行，不重置日预算';
    console.log(
      JSON.stringify({
        status: 'skipped',
        reason: 'Daily collection already attempted',
        day: state.day,
      }),
    );
  } else {
    let snapshot;
    try {
      const counted = observeArctic(metrics);
      snapshot = await collectDeepDaily(state, counted, state.scheduledAtMs);
      metrics.candidates = snapshot.communities.reduce(
        (n, c) => n + c.returned,
        0,
      );
      metrics.qualified = snapshot.screening?.qualified ?? null;
      metrics.finalists = snapshot.finalists.length;
    } catch (error) {
      await site({
        action: 'failed',
        day: state.day,
        token: state.token,
        requests: metrics.requests,
        upstreamStatus:
          error instanceof RedditRssError ? error.status : undefined,
        retryAfter:
          error instanceof RedditRssError ? error.retryAfter : undefined,
      });
      throw new Error(
        `Deep source collection failed after ${metrics.requests} requests`,
      );
    }
    metrics.aiCalls = null; // Do not report zero if ingestion completed but its response was lost.
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
      aiCalls?: number;
      diagnostics?: Array<Record<string, unknown>>;
    };
    metrics.status = result.status;
    metrics.published = result.accepted;
    metrics.rejected = result.rejected;
    metrics.failed = result.failed;
    metrics.aiCalls = result.aiCalls ?? null;
    // JSON-escaped lines cannot create GitHub workflow commands. No input bodies or secrets.
    for (const event of result.diagnostics ?? [])
      console.log(JSON.stringify({ deep_ai: event }));
    const { diagnostics: _diagnostics, ...counts } = result;
    console.log(JSON.stringify(counts));
    if (result.status !== 'completed')
      throw new Error('Deep analysis partially failed; see run status');
  }
}
try {
  await collect();
} finally {
  await writeWorkflowSummary('每日深度分析', metrics);
}
