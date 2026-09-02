import { handleJobRequest } from '@/lib/collector/http-handler';

export async function POST(request: Request) {
  return handleJobRequest(request, 'daily');
}
