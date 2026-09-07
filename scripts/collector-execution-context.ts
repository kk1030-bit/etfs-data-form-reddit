import { execFileSync } from 'node:child_process';

export function collectorExecutionContext(
  variables: Record<string, string | undefined> = process.env,
  localRevision = () =>
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
): string {
  const revision = variables.GITHUB_SHA ?? localRevision();
  if (!/^[a-f0-9]{40,64}$/i.test(revision))
    throw new Error('Collector code revision missing or invalid');
  return variables.GITHUB_ACTIONS === 'true'
    ? `github-actions:ubuntu-24.04:${revision}`
    : `local:${process.platform}:${revision}`;
}
