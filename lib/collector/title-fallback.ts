import { cleanRedditMarkdown, sha256Hex } from './core.ts';
import { analyzeTitle, hasLlmProvider, type LlmEnv } from './llm.ts';
import { withRssCooldown } from './rss-cooldown.ts';
import { RedditRssError } from './reddit-rss.ts';

const FEED =
  'https://news.google.com/rss/search?q=site%3Areddit.com%2Fr%2FETFs%20when%3A2d&hl=en-US&gl=US&ceid=US%3Aen';
export type TitleIndexItem = {
  id: string;
  title: string;
  titleZh: string;
  summaryZh: string;
  link: string;
  indexedPublishedAt: string;
  analysisStatus: string;
};
export type TitleFallback = {
  checkedAt: string;
  sourceCount: number;
  items: TitleIndexItem[];
};

function usefulTitle(title: string) {
  return !/^(money|hi|hello|help|question|advice|portfolio)[!?.\s]*$/i.test(
    title.trim(),
  );
}

function xmlText(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
  };
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
      (_match, key: string) => {
        if (key[0] !== '#') return named[key.toLowerCase()] ?? '';
        const point =
          key[1]?.toLowerCase() === 'x'
            ? parseInt(key.slice(2), 16)
            : parseInt(key.slice(1), 10);
        return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : '';
      },
    );
}

export function parseTitleIndex(
  xml: string,
  now = Date.now(),
): Omit<TitleIndexItem, 'id' | 'titleZh' | 'summaryZh' | 'analysisStatus'>[] {
  if (!/<rss[\s>]/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Invalid title RSS');
  const items = new Map<
    string,
    Omit<TitleIndexItem, 'id' | 'titleZh' | 'summaryZh' | 'analysisStatus'>
  >();
  const tag = (item: string, name: string) =>
    xmlText(
      item.match(
        new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'),
      )?.[1] ?? '',
    ).trim();
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    if (items.size >= 100) break;
    const item = match[1];
    const source = xmlText(
      item.match(/<source\s[^>]*url=["']([^"']+)["']/i)?.[1] ?? '',
    );
    const title = cleanRedditMarkdown(
      tag(item, 'title').replace(/\s*[-–—]\s*Reddit\s*$/i, ''),
    ).slice(0, 500);
    const link = tag(item, 'link');
    const timestamp = Date.parse(tag(item, 'pubDate'));
    try {
      const publisher = new URL(source);
      const url = new URL(link);
      if (
        publisher.protocol !== 'https:' ||
        !['www.reddit.com', 'reddit.com'].includes(publisher.hostname)
      )
        continue;
      if (
        url.origin !== 'https://news.google.com' ||
        !/^\/rss\/articles\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
        url.username ||
        url.password
      )
        continue;
      if (
        !title ||
        !usefulTitle(title) ||
        !Number.isFinite(timestamp) ||
        timestamp > now ||
        timestamp < now - 48 * 3600000
      )
        continue;
      items.set(title.toLowerCase(), {
        title,
        link: url.href,
        indexedPublishedAt: new Date(timestamp).toISOString(),
      });
    } catch {
      /* Invalid or non-Reddit publisher links never enter the index. */
    }
  }
  return [...items.values()].sort(
    (a, b) =>
      b.indexedPublishedAt.localeCompare(a.indexedPublishedAt) ||
      a.title.localeCompare(b.title),
  );
}

async function fetchTitleIndex(): Promise<ReturnType<typeof parseTitleIndex>> {
  const response = await fetch(FEED, {
    redirect: 'manual',
    headers: { Accept: 'application/rss+xml, application/xml;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new RedditRssError(
      `Google title index HTTP ${response.status}`,
      response.status,
      response.headers.get('retry-after') ?? undefined,
    );
  if (!/xml|rss/i.test(response.headers.get('content-type') ?? ''))
    throw new Error('Title index is not XML');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty title index');
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1000000) {
      await reader.cancel();
      throw new Error('Title index exceeds size limit');
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return parseTitleIndex(body);
}

export async function readTitleFallback(
  db: D1Database,
  now = Date.now(),
): Promise<TitleFallback | null> {
  const row = await db
    .prepare(
      "SELECT checked_at_utc, source_count, items_json FROM title_index_runs WHERE status = 'completed' AND checked_at_utc > ?1 ORDER BY logical_hour_utc DESC LIMIT 1",
    )
    .bind(new Date(now - 48 * 3600000).toISOString())
    .first<{
      checked_at_utc: string;
      source_count: number;
      items_json: string;
    }>();
  if (!row) return null;
  return {
    checkedAt: row.checked_at_utc,
    sourceCount: row.source_count,
    items: (JSON.parse(row.items_json) as TitleIndexItem[]).filter(
      (item) =>
        usefulTitle(item.title) &&
        Date.parse(item.indexedPublishedAt) > now - 48 * 3600000,
    ),
  };
}

export async function collectTitleFallback(
  env: LlmEnv & { DB: D1Database; TITLE_INDEX_EXTERNAL?: string },
  logicalHour: string,
  importedXml?: string,
): Promise<void> {
  if (env.TITLE_INDEX_EXTERNAL === '1' && !importedXml) return;
  const now = new Date().toISOString();
  await env.DB.prepare('DELETE FROM title_index_runs WHERE checked_at_utc < ?1')
    .bind(new Date(Date.now() - 48 * 3600000).toISOString())
    .run();
  const lock = await env.DB.prepare(
    "INSERT INTO title_index_runs (logical_hour_utc, checked_at_utc, status) VALUES (?1, ?2, 'running') ON CONFLICT(logical_hour_utc) DO UPDATE SET status = 'running', checked_at_utc = excluded.checked_at_utc, error = NULL WHERE title_index_runs.status = 'failed' AND ?3 = 1",
  )
    .bind(logicalHour, now, importedXml ? 1 : 0)
    .run();
  if (!lock.meta.changes) return; // Completed hours are immutable; an authenticated import may recover a failed hour.
  try {
    const previous = await readTitleFallback(env.DB);
    const candidates = await withRssCooldown(
      env.DB,
      importedXml ? async () => parseTitleIndex(importedXml) : fetchTitleIndex,
      Date.now,
      'google-title-index',
    );
    const items: TitleIndexItem[] = [];
    if (!candidates.length) throw new Error('No current Reddit titles found');
    for (const candidate of candidates.slice(0, 5)) {
      const id = await sha256Hex(candidate.title + candidate.link);
      const cached = previous?.items.find(
        (item) => item.id === id && item.analysisStatus === 'completed',
      );
      if (cached) {
        items.push(cached);
        continue;
      }
      const item: TitleIndexItem = {
        ...candidate,
        id,
        titleZh: '',
        summaryZh: '',
        analysisStatus: 'pending',
      };
      if (hasLlmProvider(env)) {
        try {
          const analysis = await analyzeTitle(env, candidate.title);
          if (analysis) {
            item.titleZh = analysis.titleZh;
            item.summaryZh = analysis.summaryZh;
            item.analysisStatus = 'completed';
          }
        } catch {
          item.analysisStatus = 'failed';
        }
      }
      items.push(item);
    }
    await env.DB.prepare(
      "UPDATE title_index_runs SET status = 'completed', items_json = ?1, source_count = ?2, checked_at_utc = ?3 WHERE logical_hour_utc = ?4",
    )
      .bind(
        JSON.stringify(items),
        candidates.length,
        new Date().toISOString(),
        logicalHour,
      )
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE title_index_runs SET status = 'failed', error = ?1 WHERE logical_hour_utc = ?2",
    )
      .bind(
        error instanceof Error
          ? error.message.slice(0, 500)
          : 'Title fallback failed',
        logicalHour,
      )
      .run();
  }
}

export async function enrichSavedTitleFallback(
  env: LlmEnv & { DB: D1Database },
) {
  const row = await env.DB.prepare(
    "SELECT logical_hour_utc, items_json FROM title_index_runs WHERE status = 'completed' AND checked_at_utc > ?1 ORDER BY logical_hour_utc DESC LIMIT 1",
  )
    .bind(new Date(Date.now() - 48 * 3600000).toISOString())
    .first<{ logical_hour_utc: string; items_json: string }>();
  if (!row) return { stored: 0, translated: 0 };
  const items = (JSON.parse(row.items_json) as TitleIndexItem[])
    .filter(
      (item) =>
        usefulTitle(item.title) &&
        Date.parse(item.indexedPublishedAt) > Date.now() - 48 * 3600000,
    )
    .slice(0, 5);
  for (const item of items) {
    if (
      item.analysisStatus === 'completed' &&
      /[\u3400-\u9fff]/.test(item.titleZh)
    )
      continue;
    try {
      const analysis = await analyzeTitle(env, item.title);
      if (analysis) {
        Object.assign(item, analysis);
        item.analysisStatus = 'completed';
      }
    } catch {
      item.analysisStatus = 'failed';
    }
  }
  await env.DB.prepare(
    "UPDATE title_index_runs SET items_json = ?1 WHERE logical_hour_utc = ?2 AND status = 'completed'",
  )
    .bind(JSON.stringify(items), row.logical_hour_utc)
    .run();
  return {
    stored: items.length,
    translated: items.filter((item) => item.analysisStatus === 'completed')
      .length,
  };
}
