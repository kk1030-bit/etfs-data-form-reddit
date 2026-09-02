import { env } from 'cloudflare:workers';

export async function GET() {
  try {
    const runtime = env as unknown as {
      AI?: unknown;
      REDDIT_SOURCE_MODE?: string;
      WORKERS_AI_ACCOUNT_ID?: string;
      WORKERS_AI_API_TOKEN?: string;
      OPENAI_API_KEY?: string;
    };
    const result = await env.DB.prepare('SELECT 1 AS ok').first<{
      ok: number;
    }>();
    return Response.json({
      ok: result?.ok === 1,
      service: 'etfs-hot-topics-dashboard',
      sourceMode:
        runtime.REDDIT_SOURCE_MODE?.trim().toLowerCase() === 'oauth'
          ? 'oauth'
          : 'rss-preview',
      aiConfigured: Boolean(
        runtime.AI ||
        (runtime.WORKERS_AI_ACCOUNT_ID && runtime.WORKERS_AI_API_TOKEN) ||
        runtime.OPENAI_API_KEY,
      ),
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        service: 'etfs-hot-topics-dashboard',
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
