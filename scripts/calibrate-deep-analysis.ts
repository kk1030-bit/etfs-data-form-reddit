import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { DEEP_RUBRIC_VERSION } from '../lib/collector/deep-analysis-policy.ts';
import {
  compareCalibration,
  type CalibrationRow,
} from '../lib/collector/deep-analysis-calibration.ts';
import type { DeepBackfill } from '../lib/collector/deep-analysis-source.ts';

// Explicit invocation only. Never uploads the raw corpus to GitHub or publishes old posts.
const inputPath = resolve(
  process.argv[2] ?? 'outputs/deep-analysis-ops-review/collection.json',
);
const outputDir = resolve('outputs/deep-analysis-calibration');
const withinOutputs = relative(resolve('outputs'), inputPath);
if (withinOutputs.startsWith('..') || isAbsolute(withinOutputs))
  throw new Error('Calibration input must be within local outputs/');
const corpus = JSON.parse(await readFile(inputPath, 'utf8')) as DeepBackfill;
if (
  !Number.isFinite(Date.parse(corpus.fetchedAt)) ||
  Date.now() - Date.parse(corpus.fetchedAt) > 48 * 3600000
)
  throw new Error(
    'Raw backfill expired (48 hours); refresh the backfill before resuming. Derived reviews are reusable.',
  );
if (!process.env.TITLE_INGEST_TOKEN)
  throw new Error(
    'TITLE_INGEST_TOKEN is required via the environment, never as a CLI argument',
  );
await mkdir(outputDir, { recursive: true });
const resultsFile = resolve(outputDir, 'reviews.json');
let rows: CalibrationRow[] = [];
try {
  rows = JSON.parse(await readFile(resultsFile, 'utf8')) as CalibrationRow[];
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const current = new Map(
  rows
    .filter((r) => r.rubricVersion === DEEP_RUBRIC_VERSION)
    .map((r) => [r.id, r]),
);
const posts = corpus.posts.filter(
  (p) =>
    typeof p.selftext === 'string' &&
    Array.from(p.selftext.trim()).length >= 1000 &&
    p.is_self === true &&
    typeof p.created_utc === 'number' &&
    p.created_utc * 1000 <= Date.now() &&
    p.created_utc * 1000 >= Date.now() - 30 * 86400000 &&
    !['accepted', 'rejected'].includes(current.get(String(p.id))?.status ?? ''),
);
let attempts = 0;
for (const post of posts) {
  if (attempts >= 40) break; // Server enforces 40/day across runs, including retries, under global 128/day.
  const response = await fetch(
    'https://etfs-hot-topics.wangguancc.chatgpt.site/api/internal/deep-analysis',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.TITLE_INGEST_TOKEN}`,
      },
      body: JSON.stringify({ action: 'calibrate', post }),
      redirect: 'manual',
      signal: AbortSignal.timeout(150000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Calibration HTTP ${response.status}; stopped without resetting any run`,
    );
  const result = (await response.json()) as CalibrationRow & {
    diagnostics?: Array<Record<string, unknown>>;
  };
  if (
    result.id !== post.id ||
    result.rubricVersion !== DEEP_RUBRIC_VERSION ||
    !Number.isInteger(result.aiCalls)
  )
    throw new Error('Invalid calibration response');
  attempts += result.aiCalls;
  // Raw AI responses in this run's log only; no original input or credentials are logged.
  console.log(
    JSON.stringify({ id: result.id, diagnostics: result.diagnostics }),
  );
  if (result.status === 'budget') break;
  const { diagnostics: _diagnostics, ...derived } = result;
  current.set(result.id, derived);
  rows = [...current.values()];
  await writeFile(resultsFile, JSON.stringify(rows, null, 2), 'utf8');
}
const report = compareCalibration([...current.values()]);
await writeFile(
  resolve(dirname(resultsFile), 'feature-comparison.json'),
  JSON.stringify(report, null, 2),
  'utf8',
);
const summary = `Calibration: ${report.accepted} accepted, ${report.rejected} rejected, ${report.technicalFailures} technical failures; ${attempts} AI attempts this invocation. Remaining items resume on a later invocation. Old posts are never published.\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
