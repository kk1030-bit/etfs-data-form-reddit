import { mkdir, writeFile } from 'node:fs/promises';
import { collectDeepBackfill } from '../lib/collector/deep-analysis-source.ts';

// Operator-only local experiment. Not imported by the Site or hourly workflow.
const result = await collectDeepBackfill();
const directory = new URL(
  process.argv.includes('--review')
    ? '../outputs/deep-analysis-ops-review/'
    : '../outputs/deep-analysis-backfill/',
  import.meta.url,
);
await mkdir(directory, { recursive: true });
// Temporary local input for the approved scoring run; never sent to AI or D1.
await writeFile(
  new URL('collection.json', directory),
  JSON.stringify(result),
  'utf8',
);
const audit = {
  fetchedAt: result.fetchedAt,
  window: result.window,
  requests: result.requests,
  communities: result.communities,
};
await writeFile(
  new URL('flair-audit.json', directory),
  JSON.stringify(audit, null, 2),
  'utf8',
);
console.log(JSON.stringify(audit, null, 2));
