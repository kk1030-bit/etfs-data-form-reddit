import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectTitleFallback,
  parseTitleIndex,
  readTitleFallback,
} from '../lib/collector/title-fallback.ts';
import { logicalHourIso } from '../lib/collector/core.ts';
import { testDb } from './d1-test-db.ts';

const now = Date.now();
const item = (
  title = 'VOO &amp; VTI - Reddit',
  date = now - 3600000,
  source = 'https://www.reddit.com',
  link = 'https://news.google.com/rss/articles/CBMiExample?oc=5',
) =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${new Date(date).toUTCString()}</pubDate><source url="${source}">Reddit</source></item>`;
const feed = (items: string) =>
  `<rss version="2.0"><channel>${items}</channel></rss>`;

void test('external mode skips network, imports once, and rejects empty current feeds', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new Error('Unexpected network request');
  };
  const env = { DB: fixture.db, TITLE_INDEX_EXTERNAL: '1' };
  const hour = logicalHourIso(now);
  await collectTitleFallback(env, hour);
  assert.equal(await readTitleFallback(fixture.db), null);
  await collectTitleFallback(env, hour, feed(''));
  assert.equal(
    fixture.sqlite.prepare('SELECT status FROM title_index_runs').get()?.status,
    'failed',
  );
  await collectTitleFallback(env, hour, feed(item()));
  assert.equal((await readTitleFallback(fixture.db))?.items.length, 1);
  await collectTitleFallback(env, hour, feed(item('Replacement ETF')));
  assert.equal(
    (await readTitleFallback(fixture.db))?.items[0].title,
    'VOO & VTI',
  );
});

void test('title fallback validates publisher and link host, decodes text, removes duplicates, and rejects stale/future data', () => {
  const parsed = parseTitleIndex(
    feed(
      item() +
        item() +
        item('Future ETF', now + 10000) +
        item('Old ETF', now - 49 * 3600000) +
        item('Other ETF', now - 1000, 'https://evil.test') +
        item(
          'Bad link ETF',
          now - 1000,
          'https://www.reddit.com',
          'https://news.google.com.evil.test/rss/articles/x',
        ) +
        item('New ETF - Reddit', now - 1000),
    ),
    now,
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'New ETF');
  assert.equal(parsed[1].title, 'VOO & VTI');
  assert.equal('author' in parsed[0], false);
  assert.equal('comments' in parsed[0], false);
  assert.throws(() => parseTitleIndex('<!DOCTYPE x><rss></rss>'), /Invalid/);
});

void test('title fallback is persisted separately, uses edge-safe redirects, and requests at most once per hour', async (t) => {
  const fixture = testDb();
  t.after(fixture.close);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    assert.equal(
      new URL(input instanceof Request ? input.url : input).hostname,
      'news.google.com',
    );
    return new Response(feed(item()), {
      headers: { 'Content-Type': 'application/xml' },
    });
  };
  const env = { DB: fixture.db };
  await collectTitleFallback(env, logicalHourIso(now));
  await collectTitleFallback(env, logicalHourIso(now));
  assert.equal(calls, 1);
  const saved = await readTitleFallback(fixture.db);
  assert.equal(saved?.items.length, 1);
  assert.equal(saved?.items[0].titleZh, '');
  assert.equal(
    fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM hourly_rankings').get()
      ?.n,
    0,
  );
});
