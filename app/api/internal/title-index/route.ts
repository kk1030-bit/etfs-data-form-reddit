import { env } from 'cloudflare:workers';
import {
  collectTitleFallback,
  enrichSavedTitleFallback,
  type TitleIndexItem,
} from '@/lib/collector/title-fallback';
import { logicalHourIso } from '@/lib/collector/core';
import {
  readRssSourceState,
  withRssCooldown,
} from '@/lib/collector/rss-cooldown';
import { RedditRssError } from '@/lib/collector/reddit-rss';
import type { LlmEnv } from '@/lib/collector/llm';

type Runtime = LlmEnv & {
  DB: D1Database;
  TITLE_INGEST_TOKEN?: string;
  TITLE_INDEX_EXTERNAL?: string;
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function authorized(request: Request, runtime: Runtime) {
  return (
    Boolean(runtime.TITLE_INGEST_TOKEN) &&
    request.headers.get('authorization') ===
      `Bearer ${runtime.TITLE_INGEST_TOKEN}`
  );
}

export async function GET(request: Request) {
  const runtime = env as unknown as Runtime;
  if (!authorized(request, runtime))
    return json({ error: 'Unauthorized' }, 401);
  const hour = logicalHourIso(Date.now());
  const [state, row] = await Promise.all([
    readRssSourceState(runtime.DB, 'google-title-index'),
    runtime.DB.prepare(
      'SELECT status FROM title_index_runs WHERE logical_hour_utc = ?1',
    )
      .bind(hour)
      .first<{ status: string }>(),
  ]);
  const cooling = Boolean(
    state?.cooldown_until_utc &&
    Date.parse(state.cooldown_until_utc) > Date.now(),
  );
  return json({
    needed:
      runtime.TITLE_INDEX_EXTERNAL === '1' &&
      !cooling &&
      !['completed', 'running'].includes(row?.status ?? ''),
    cooldownUntil: state?.cooldown_until_utc ?? null,
  });
}

export async function POST(request: Request) {
  const runtime = env as unknown as Runtime;
  if (!authorized(request, runtime))
    return json({ error: 'Unauthorized' }, 401);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Body required' }, 400);
  let bytes = 0;
  let body = '';
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1000000) {
      await reader.cancel();
      return json({ error: 'Input too large' }, 413);
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  if (request.headers.get('content-type')?.includes('application/json')) {
    try {
      const failure = JSON.parse(body) as {
        action?: string;
        status?: number;
        retryAfter?: string;
      };
      if (failure.action === 'translate')
        return json(await enrichSavedTitleFallback(runtime));
      if (failure.status !== 429 && failure.status !== 503)
        return json({ error: 'Invalid failure' }, 400);
      try {
        await withRssCooldown(
          runtime.DB,
          async () => {
            throw new RedditRssError(
              `Google title index HTTP ${failure.status}`,
              failure.status,
              failure.retryAfter,
            );
          },
          Date.now,
          'google-title-index',
        );
      } catch {
        /* Provider cooldown is persisted by the shared gate. */
      }
      return json({ recorded: true });
    } catch {
      return json({ error: 'Invalid input' }, 400);
    }
  }
  if (!request.headers.get('content-type')?.includes('application/xml'))
    return json({ error: 'XML required' }, 415);
  const state = await readRssSourceState(runtime.DB, 'google-title-index');
  if (
    state?.cooldown_until_utc &&
    Date.parse(state.cooldown_until_utc) > Date.now()
  )
    return json({ error: 'Source cooldown' }, 429);
  const hour = logicalHourIso(Date.now());
  await collectTitleFallback(runtime, hour, body);
  const result = await runtime.DB.prepare(
    'SELECT status, items_json, checked_at_utc FROM title_index_runs WHERE logical_hour_utc = ?1',
  )
    .bind(hour)
    .first<{ status: string; items_json: string; checked_at_utc: string }>();
  if (result?.status !== 'completed')
    return json(
      { error: 'Current-hour title ingestion did not complete' },
      502,
    );
  const items = JSON.parse(result.items_json) as TitleIndexItem[];
  if (!items.length)
    return json({ error: 'No current Reddit titles stored' }, 502);
  return json({
    stored: items.length,
    translated: items.filter((item) => item.analysisStatus === 'completed')
      .length,
    checkedAt: result.checked_at_utc,
  });
}
