import { env } from 'cloudflare:workers';

import { runJob, type CollectorEnv } from './jobs';
import { RedditRssError } from './reddit-rss';

export async function handleJobRequest(
  request: Request,
  kind: 'hourly' | 'daily' | 'weekly',
): Promise<Response> {
  const runtime = env as unknown as CollectorEnv;
  if (
    !runtime.JOB_SECRET ||
    request.headers.get('authorization') !== `Bearer ${runtime.JOB_SECRET}`
  ) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const scheduledAtHeader = request.headers.get('x-scheduled-at');
  const scheduledAtMs = scheduledAtHeader
    ? Number(scheduledAtHeader)
    : Date.now();
  if (!Number.isFinite(scheduledAtMs)) {
    return Response.json({ error: 'Invalid x-scheduled-at' }, { status: 400 });
  }
  try {
    const result = await runJob(runtime, kind, scheduledAtMs);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (result.retryAtUtc)
      headers.set(
        'Retry-After',
        String(
          Math.max(
            0,
            Math.ceil((Date.parse(result.retryAtUtc) - Date.now()) / 1_000),
          ),
        ),
      );
    // Cooldown is a handled scheduler outcome, not a server crash. The JSON
    // retains upstreamStatus=429 while the Cron receives a successful response.
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        kind,
        upstreamStatus:
          error instanceof RedditRssError ? (error.status ?? null) : null,
      },
      {
        status:
          error instanceof RedditRssError
            ? error.status === 429
              ? 429
              : 502
            : 500,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
