const site =
  'https://etfs-hot-topics.wangguancc.chatgpt.site/api/internal/title-index';
const feed =
  'https://news.google.com/rss/search?q=site%3Areddit.com%2Fr%2FETFs%20when%3A2d&hl=en-US&gl=US&ceid=US%3Aen';
if (!process.env.TITLE_INGEST_TOKEN || !process.env.SITE_BYPASS_TOKEN)
  throw new Error('Collector secrets missing');
const headers = {
  Authorization: `Bearer ${process.env.TITLE_INGEST_TOKEN}`,
  'OAI-Sites-Authorization': `Bearer ${process.env.SITE_BYPASS_TOKEN}`,
};
const state = await fetch(site, {
  headers,
  redirect: 'manual',
  signal: AbortSignal.timeout(20000),
});
if (!state.ok) throw new Error(`Collector state HTTP ${state.status}`);
if (!(await state.json()).needed) {
  console.log(
    'No collection needed for this hour, or provider cooldown active.',
  );
  process.exit(0);
}
const response = await fetch(feed, {
  headers: { Accept: 'application/rss+xml, application/xml;q=0.9' },
  redirect: 'manual',
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) {
  if ([429, 503].includes(response.status))
    await fetch(site, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: response.status,
        retryAfter: response.headers.get('retry-after') ?? undefined,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
  throw new Error(
    `Public title index HTTP ${response.status}; no retry performed`,
  );
}
if (!/xml|rss/i.test(response.headers.get('content-type') ?? ''))
  throw new Error('Public title response is not XML');
const reader = response.body.getReader();
let body = '';
let bytes = 0;
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  bytes += value.byteLength;
  if (bytes > 1000000) {
    await reader.cancel();
    throw new Error('Feed exceeds size limit');
  }
  body += decoder.decode(value, { stream: true });
}
body += decoder.decode();
const result = await fetch(site, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/xml' },
  body,
  redirect: 'manual',
  signal: AbortSignal.timeout(360000),
});
if (!result.ok) throw new Error(`Index storage HTTP ${result.status}`);
const outcome = await result.json();
console.log(
  JSON.stringify({
    stored: outcome.stored,
    translated: outcome.translated,
    checkedAt: outcome.checkedAt,
  }),
);
if (!outcome.stored) throw new Error('No current Reddit titles were stored');
