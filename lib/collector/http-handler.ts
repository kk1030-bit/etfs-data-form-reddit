import { env } from 'cloudflare:workers';

import { runJob, type CollectorEnv } from './jobs';

export async function handleJobRequest(
  request: Request,
  kind: 'hourly' | 'daily' | 'weekly',
): Promise<Response> {
  const runtime = env as unknown as CollectorEnv;
  if (!runtime.JOB_SECRET || request.headers.get('authorization') !== `Bearer ${runtime.JOB_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const scheduledAtHeader = request.headers.get('x-scheduled-at');
  const scheduledAtMs = scheduledAtHeader ? Number(scheduledAtHeader) : Date.now();
  if (!Number.isFinite(scheduledAtMs)) {
    return Response.json({ error: 'Invalid x-scheduled-at' }, { status: 400 });
  }
  try {
    return Response.json(await runJob(runtime, kind, scheduledAtMs), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error), kind },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
