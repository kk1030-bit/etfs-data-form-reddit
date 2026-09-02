import { DashboardApp } from '@/components/dashboard-app';
import { getDashboardData } from '@/lib/dashboard-data';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const data = await getDashboardData();
  return <DashboardApp initialData={data} />;
}
