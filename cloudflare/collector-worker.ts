import { fetchIndexedCandidates } from '../lib/collector/arctic-shift.ts';

type CronEnv = {
  SITE_BASE_URL: string;
  JOB_SECRET: string;
  SITE_BYPASS_TOKEN?: string;
  AI: Ai;
  AI_RELAY_SECRET?: string;
};

const CRON_JOB: Record<string, 'hourly' | 'daily' | 'weekly'> = {
  '0 * * * *': 'hourly',
  '0 16 * * *': 'daily',
  '10 16 * * SUN': 'weekly',
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function invokeSiteJob(
  env: CronEnv,
  kind: 'hourly' | 'daily' | 'weekly',
  scheduledAtMs: number,
): Promise<Response> {
  const base = new URL(env.SITE_BASE_URL);
  if (base.protocol !== 'https:')
    throw new Error('SITE_BASE_URL must use HTTPS');
  const url = new URL(`/api/internal/jobs/${kind}`, base);
  const headers = new Headers({
    Authorization: `Bearer ${env.JOB_SECRET}`,
    'X-Scheduled-At': String(scheduledAtMs),
    'User-Agent': 'etfs-hot-topics-cron/0.1.0',
  });
  if (env.SITE_BYPASS_TOKEN) {
    headers.set('OAI-Sites-Authorization', `Bearer ${env.SITE_BYPASS_TOKEN}`);
  }
  return fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(14 * 60 * 1_000),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health')
      return json({ ok: true, service: 'etfs-hot-topics-cron' });
    if (url.pathname === '/source-health' && request.method === 'GET') {
      if (request.headers.get('authorization') !== `Bearer ${env.JOB_SECRET}`)
        return json({ error: 'Unauthorized' }, 401);
      try {
        const result = await fetchIndexedCandidates({
          REDDIT_SUBREDDITS: 'ETFs',
        });
        return json({
          candidates: result.candidates.length,
          details: result.details,
        });
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Source health request failed',
          },
          502,
        );
      }
    }
    if (url.pathname === '/ai' && request.method === 'POST') {
      if (
        !env.AI_RELAY_SECRET ||
        request.headers.get('authorization') !== `Bearer ${env.AI_RELAY_SECRET}`
      )
        return json({ error: 'Unauthorized' }, 401);
      if (Number(request.headers.get('content-length')) > 8000)
        return json({ error: 'Input too large' }, 413);
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > 8000)
          return json({ error: 'Input too large' }, 413);
        const input = JSON.parse(raw) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        if (
          !Array.isArray(input.messages) ||
          input.messages.length !== 2 ||
          input.messages[0].role !== 'system' ||
          input.messages[1].role !== 'user' ||
          input.messages.some((m) => typeof m.content !== 'string')
        )
          return json({ error: 'Invalid input' }, 400);
        if (
          new TextEncoder().encode(
            input.messages.map((m) => m.content).join(''),
          ).length > 6000
        )
          return json({ error: 'Input exceeds free-budget limit' }, 413);
        const result = await env.AI.run('@cf/qwen/qwen3-30b-a3b-fp8', {
          messages: input.messages as Array<{
            role: 'system' | 'user';
            content: string;
          }>,
          max_tokens: 1000,
          temperature: 0.1,
        });
        return json(result);
      } catch {
        return json(
          {
            error: 'Free AI service temporarily unavailable or quota exhausted',
          },
          503,
        );
      }
    }
    const match = url.pathname.match(/^\/run\/(hourly|daily|weekly)$/);
    if (request.method !== 'POST' || !match)
      return json({ error: 'Not found' }, 404);
    if (request.headers.get('authorization') !== `Bearer ${env.JOB_SECRET}`) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const kind = match[1] as 'hourly' | 'daily' | 'weekly';
    const upstream = await invokeSiteJob(env, kind, Date.now());
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  },

  async scheduled(controller, env, ctx) {
    const kind = CRON_JOB[controller.cron];
    if (!kind) throw new Error(`Unknown cron expression: ${controller.cron}`);
    ctx.waitUntil(
      invokeSiteJob(env, kind, controller.scheduledTime).then(
        async (response) => {
          if (!response.ok)
            throw new Error(
              `Site job ${kind} failed: ${response.status} ${(await response.text()).slice(0, 500)}`,
            );
        },
      ),
    );
  },
} satisfies ExportedHandler<CronEnv>;
