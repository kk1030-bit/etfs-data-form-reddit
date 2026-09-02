import { getDashboardData } from '@/lib/dashboard-data';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await getDashboardData(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
