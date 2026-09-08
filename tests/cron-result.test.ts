import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSiteJobResponse } from '../cloudflare/cron-result.ts';

void test('Cron distinguishes dispatched work from completed collection without logging raw errors', async () => {
  const logs: unknown[] = [];
  await inspectSiteJobResponse(
    Response.json({
      status: 'skipped',
      scheduler: { status: 'dispatched', attempts: 1 },
      error: 'must-not-appear',
    }),
    'hourly',
    (value) => logs.push(value),
  );
  assert.deepEqual(logs, [
    {
      event: 'site_job_checked',
      kind: 'hourly',
      outcome: 'skipped',
      schedulerStatus: 'dispatched',
      dispatchAttempts: 1,
    },
  ]);
  assert.ok(!JSON.stringify(logs).includes('must-not-appear'));
});

void test('Cron reports missing configuration, failures and exhausted dispatch budget even on HTTP 200', async () => {
  for (const status of ['unconfigured', 'failed', 'exhausted']) {
    await assert.rejects(
      inspectSiteJobResponse(
        Response.json({
          status: 'skipped',
          scheduler: { status },
        }),
        'hourly',
        () => {},
      ),
      new RegExp(status),
    );
  }
  await assert.rejects(
    inspectSiteJobResponse(
      new Response('secret body', { status: 503 }),
      'hourly',
    ),
    {
      message: 'Site job hourly failed: HTTP 503',
    },
  );
});

void test('Cron preserves successful report/handled-cooldown outcomes and rejects malformed protocol', async () => {
  for (const kind of ['hourly', 'daily', 'weekly'] as const) {
    await inspectSiteJobResponse(
      Response.json({ status: 'completed' }),
      kind,
      () => {},
    );
  }
  await inspectSiteJobResponse(
    Response.json({ status: 'cooldown' }),
    'hourly',
    () => {},
  );
  for (const body of ['<html>unexpected</html>', '{}', 'null']) {
    await assert.rejects(
      inspectSiteJobResponse(new Response(body), 'hourly'),
      /invalid outcome/,
    );
  }
});

void test('Cron reports deep dispatch separately and surfaces deep failures even if hourly is complete', async () => {
  const logs: unknown[] = [];
  await inspectSiteJobResponse(
    Response.json({
      status: 'skipped',
      scheduler: { status: 'completed' },
      deepScheduler: { status: 'dispatched', attempts: 1, error: 'do-not-log' },
    }),
    'hourly',
    (value) => logs.push(value),
  );
  assert.match(JSON.stringify(logs), /deepSchedulerStatus/);
  assert.match(JSON.stringify(logs), /dispatched/);
  assert.ok(!JSON.stringify(logs).includes('do-not-log'));
  for (const status of ['failed', 'unconfigured', 'exhausted'])
    await assert.rejects(
      inspectSiteJobResponse(
        Response.json({
          status: 'skipped',
          scheduler: { status: 'completed' },
          deepScheduler: { status },
        }),
        'hourly',
        () => {},
      ),
      /Deep analysis scheduler needs attention/,
    );
});
