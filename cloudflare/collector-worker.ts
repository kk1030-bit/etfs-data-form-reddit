type CronEnv = {
  SITE_BASE_URL: string;
  JOB_SECRET: string;
  SITE_BYPASS_TOKEN?: string;
};

const CRON_JOB: Record<string, 'hourly' | 'daily' | 'weekly'> = {
  '0 * * * *': 'hourly',
  '0 16 * * *': 'daily',
  '10 16 * * SUN': 'weekly',
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function invokeSiteJob(
  env: CronEnv,
  kind: 'hourly' | 'daily' | 'weekly',
  scheduledAtMs: number,
): Promise<Response> {
  const base = new URL(env.SITE_BASE_URL);
  if (base.protocol !== 'https:') throw new Error('SITE_BASE_URL must use HTTPS');
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
    if (url.pathname === '/health') return json({ ok: true, service: 'etfs-hot-topics-cron' });
    const match = url.pathname.match(/^\/run\/(hourly|daily|weekly)$/);
    if (request.method !== 'POST' || !match) return json({ error: 'Not found' }, 404);
    if (request.headers.get('authorization') !== `Bearer ${env.JOB_SECRET}`) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const kind = match[1] as 'hourly' | 'daily' | 'weekly';
    const upstream = await invokeSiteJob(env, kind, Date.now());
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  },

  async scheduled(controller, env, ctx) {
    const kind = CRON_JOB[controller.cron];
    if (!kind) throw new Error(`Unknown cron expression: ${controller.cron}`);
    ctx.waitUntil(
      invokeSiteJob(env, kind, controller.scheduledTime).then(async (response) => {
        if (!response.ok) throw new Error(`Site job ${kind} failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
      }),
    );
  },
} satisfies ExportedHandler<CronEnv>;
