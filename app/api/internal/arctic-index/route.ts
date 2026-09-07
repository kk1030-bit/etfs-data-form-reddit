import { env } from 'cloudflare:workers';
import {
  DEFAULT_SUBREDDITS,
  DEFAULT_ETF_KEYWORDS,
  logicalHourIso,
  parseCsv,
} from '@/lib/collector/core';
import {
  readRssSourceState,
  prepareArcticContext,
  resetArcticCooldown,
  RssDeferredError,
} from '@/lib/collector/rss-cooldown';
import { redditSourceMode } from '@/lib/collector/reddit';
import { parseArcticSnapshot } from '@/lib/collector/arctic-snapshot';
import { runHourly, type CollectorEnv } from '@/lib/collector/jobs';

type Runtime = CollectorEnv & { TITLE_INGEST_TOKEN?: string };
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
  const now = Date.now();
  const hour = logicalHourIso(now);
  const [state, run, tracked] = await Promise.all([
    readRssSourceState(runtime.DB, 'arctic-shift'),
    runtime.DB.prepare(
      'SELECT status, started_at_utc FROM job_runs WHERE id = ?1',
    )
      .bind(`hourly:${hour}`)
      .first<{ status: string; started_at_utc: string }>(),
    runtime.DB.prepare(
      "SELECT DISTINCT post_id FROM tracking_episodes WHERE status = 'active' AND expires_at_utc > ?1 AND started_at_utc <= ?1 LIMIT 120",
    )
      .bind(new Date(now).toISOString())
      .all<{ post_id: string }>(),
  ]);
  const cooling = Boolean(
    state?.cooldown_until_utc && Date.parse(state.cooldown_until_utc) > now,
  );
  const busy =
    Boolean(
      state?.lease_until_utc && Date.parse(state.lease_until_utc) > now,
    ) ||
    (run?.status === 'running' &&
      Date.parse(run.started_at_utc) > now - 20 * 60000);
  if (request.headers.get('x-collector-context') !== state?.execution_context)
    return json({ error: 'Prepare collector context first' }, 409);
  return json({
    reason:
      runtime.ARCTIC_SHIFT_EXTERNAL !== '1' ||
      redditSourceMode(runtime) !== 'arctic-shift'
        ? 'disabled'
        : run?.status === 'completed'
          ? 'already_completed'
          : cooling
            ? 'cooldown'
            : busy
              ? 'busy'
              : 'collection_needed',
    needed:
      runtime.ARCTIC_SHIFT_EXTERNAL === '1' &&
      redditSourceMode(runtime) === 'arctic-shift' &&
      !cooling &&
      !busy &&
      run?.status !== 'completed',
    cooldownUntil: state?.cooldown_until_utc ?? null,
    executionContext: state?.execution_context,
    scheduledAtMs: now,
    logicalHour: hour,
    subreddits: parseCsv(runtime.REDDIT_SUBREDDITS, DEFAULT_SUBREDDITS).slice(
      0,
      6,
    ),
    keywords: parseCsv(runtime.ETF_KEYWORDS, DEFAULT_ETF_KEYWORDS),
    trackedIds: (tracked.results ?? []).map((row) => row.post_id),
  });
}

export async function POST(request: Request) {
  const runtime = env as unknown as Runtime;
  if (!authorized(request, runtime))
    return json({ error: 'Unauthorized' }, 401);
  if (
    runtime.ARCTIC_SHIFT_EXTERNAL !== '1' ||
    redditSourceMode(runtime) !== 'arctic-shift'
  )
    return json({ error: 'External collector disabled' }, 409);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return json({ error: 'JSON required' }, 415);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Body required' }, 400);
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4_000_000) {
      await reader.cancel();
      return json({ error: 'Input too large' }, 413);
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  let input: {
    action?: string;
    executionContext?: string;
    scheduledAtMs: number;
    snapshot?: unknown;
    failure?: { status?: number; retryAfter?: string };
  };
  try {
    input = JSON.parse(raw);
    const context = input.executionContext;
    if (
      typeof context !== 'string' ||
      !/^(github-actions|local):[A-Za-z0-9._:-]{1,160}$/.test(context)
    )
      return json({ error: 'Valid collector context required' }, 400);
    if (input.action === 'prepare') {
      const state = await prepareArcticContext(runtime.DB, context);
      return json({
        status: 'prepared',
        executionContext: state.execution_context,
        consecutive429: state.consecutive_429,
        cooldownUntil: state.cooldown_until_utc,
      });
    }
    const state = await readRssSourceState(runtime.DB, 'arctic-shift');
    if (state?.execution_context !== context)
      return json({ error: 'Stale collector context' }, 409);
    if (
      !Number.isFinite(input.scheduledAtMs) ||
      input.scheduledAtMs > Date.now() ||
      Date.now() - input.scheduledAtMs > 15 * 60000
    )
      throw new Error('Invalid timestamp');
    if (
      input.failure &&
      (input.snapshot ||
        (input.failure.status !== undefined &&
          (!Number.isInteger(input.failure.status) ||
            input.failure.status < 400 ||
            input.failure.status > 599)) ||
        (input.failure.retryAfter !== undefined &&
          (typeof input.failure.retryAfter !== 'string' ||
            input.failure.retryAfter.length > 100)))
    )
      throw new Error('Invalid failure');
    const external = input.failure
      ? { failure: input.failure, executionContext: context }
      : {
          snapshot: parseArcticSnapshot(input.snapshot, runtime),
          executionContext: context,
        };
    const aiUsage = { requests: 0 };
    const result = await runHourly(
      { ...runtime, AI_CALLS: aiUsage },
      input.scheduledAtMs,
      external,
    );
    return json({ ...result, aiCalls: aiUsage.requests });
  } catch (error) {
    if (error instanceof RssDeferredError)
      return json(
        { error: 'Collector in progress', retryAtUtc: error.retryAtUtc },
        409,
      );
    console.error(
      'Arctic ingest failed',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return json({ error: 'Arctic ingestion failed' }, 422);
  }
}

// Deliberate operator reset, never called by the scheduled collector.
export async function DELETE(request: Request) {
  const runtime = env as unknown as Runtime;
  if (
    !runtime.JOB_SECRET ||
    request.headers.get('authorization') !== `Bearer ${runtime.JOB_SECRET}`
  )
    return json({ error: 'Unauthorized' }, 401);
  try {
    return json({
      status: 'reset',
      ...(await resetArcticCooldown(runtime.DB)),
    });
  } catch (error) {
    if (error instanceof RssDeferredError)
      return json(
        { error: 'Collector in progress', retryAtUtc: error.retryAtUtc },
        409,
      );
    return json({ error: 'Reset failed' }, 500);
  }
}
