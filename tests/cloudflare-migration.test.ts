import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_SITE_BASE_URL,
  siteOrigin,
  siteEndpoint,
} from '../lib/site-config.mjs';
import collector from '../cloudflare/collector-worker.ts';

void test('collectors share the workers.dev default and accept an explicit custom domain', () => {
  assert.equal(
    new URL(DEFAULT_SITE_BASE_URL).hostname.endsWith('.workers.dev'),
    true,
  );
  assert.equal(
    siteEndpoint('/api/internal/arctic-index'),
    `${DEFAULT_SITE_BASE_URL}/api/internal/arctic-index`,
  );
  assert.equal(
    siteEndpoint('/api/internal/deep-analysis', 'https://etfs.example/'),
    'https://etfs.example/api/internal/deep-analysis',
  );
  assert.equal(siteOrigin('http://localhost:3001'), 'http://localhost:3001');
  for (const bad of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?token=private',
    'https://example.com/#hash',
  ])
    assert.throws(() => siteOrigin(bad));
  assert.throws(() => siteEndpoint('//evil.example/api/internal/jobs/hourly'));
});

void test('Cloudflare deployment and build do not depend on the Sites plugin or hosting manifest', async () => {
  const source = await readFile(
    new URL('../vite.config.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /sites-vite-plugin|hosting\.json|sites\(/);
  assert.match(source, /configPath: '\.\/wrangler\.jsonc'/);
  const config = JSON.parse(
    await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  );
  assert.equal(config.name, 'etfs-hot-topics');
  assert.equal(config.main, 'vinext/server/fetch-handler');
  assert.equal(config.vars.SITE_BASE_URL, DEFAULT_SITE_BASE_URL);
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.equal(config.d1_databases[0].database_name, 'etfs-hot-topics-db');
  for (const name of [
    'JOB_SECRET',
    'TITLE_INGEST_TOKEN',
    'GITHUB_ACTIONS_TOKEN',
    'WORKERS_AI_RELAY_TOKEN',
  ])
    assert.equal(config.vars[name], undefined);
  for (const file of [
    'collect-arctic-index.ts',
    'collect-deep-analysis.ts',
    'collect-title-index.mjs',
    'calibrate-deep-analysis.ts',
  ]) {
    const script = await readFile(
      new URL(`../scripts/${file}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      script,
      /chatgpt\.site|SITE_BYPASS_TOKEN|OAI-Sites-Authorization/,
    );
    assert.match(script, /siteEndpoint\(/);
    assert.match(script, /TITLE_INGEST_TOKEN/);
  }
});

void test('cron proxy retains JOB_SECRET authorization and sends no Sites bypass header', async (t) => {
  const saved = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = saved;
  });
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(
      String(input),
      `${DEFAULT_SITE_BASE_URL}/api/internal/jobs/hourly`,
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer test-only-job');
    assert.equal(headers.has('OAI-Sites-Authorization'), false);
    assert.equal(init?.redirect, 'manual');
    return Response.json({ status: 'skipped' });
  };
  const env = {
    SITE_BASE_URL: DEFAULT_SITE_BASE_URL,
    JOB_SECRET: 'test-only-job',
    AI: {} as Ai,
  };
  const denied = await collector.fetch(
    new Request('https://relay.example/run/hourly', { method: 'POST' }) as Request<unknown, IncomingRequestCfProperties>,
    env,
  );
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  const allowed = await collector.fetch(
    new Request('https://relay.example/run/hourly', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-only-job' },
    }) as Request<unknown, IncomingRequestCfProperties>,
    env,
  );
  assert.equal(allowed.status, 200);
  assert.equal(calls, 1);
});
