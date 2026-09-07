import { env } from 'cloudflare:workers';
import { handleDeepRequest } from '@/lib/collector/deep-analysis-store';

export async function POST(request: Request) {
  return handleDeepRequest(request, env);
}
