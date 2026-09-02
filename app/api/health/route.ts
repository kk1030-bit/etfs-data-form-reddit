import { env } from 'cloudflare:workers';

export async function GET() {
  try {
    const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return Response.json({ ok: result?.ok === 1, service: 'etfs-hot-topics-dashboard' });
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
