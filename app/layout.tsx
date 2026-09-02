import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'etfs热门话题｜Reddit ETF 情报台',
  description:
    '每小时追踪 Reddit 上最值得关注的 ETF 热门讨论，提供简体中文翻译、重点摘要与趋势报告。',
  openGraph: {
    title: 'etfs热门话题｜Reddit ETF 情报台',
    description: '每小时追踪 Reddit ETF 高互动讨论，自动生成简体中文重点摘要、日报与周报。',
    type: 'website',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'etfs热门话题' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'etfs热门话题｜Reddit ETF 情报台',
    description: 'Reddit ETF 高互动话题追踪、简中摘要与趋势报告。',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
