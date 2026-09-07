import { appendFile } from 'node:fs/promises';

export type WorkflowMetrics = {
  status: string;
  reason?: string;
  candidates: number | null;
  qualified: number | null;
  finalists?: number | null;
  published: number | null;
  rejected?: number | null;
  failed?: number | null;
  aiCalls: number | null;
  requests: number;
  remaining: number | null;
};
export const newWorkflowMetrics = (): WorkflowMetrics => ({
  status: 'failed',
  candidates: null,
  qualified: null,
  published: null,
  aiCalls: 0,
  requests: 0,
  remaining: null,
});
export function observeArctic(
  metrics: WorkflowMetrics,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://arctic-shift.photon-reddit.com')
      throw new Error('Arctic observation origin mismatch');
    metrics.requests++;
    const response = await fetcher(input, init);
    const value = response.headers.get('x-ratelimit-remaining')?.trim();
    metrics.remaining =
      value && Number.isFinite(Number(value)) && Number(value) >= 0
        ? Number(value)
        : null;
    return response;
  };
}
export function workflowSummary(
  kind: string,
  metrics: WorkflowMetrics,
): string {
  const safe = (value: string) =>
    value.replace(/[\r\n|<>`[\]]/g, ' ').slice(0, 160);
  const count = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? String(value)
      : '未取得';
  return [
    `## ${safe(kind)}`,
    '',
    `状态：${safe(metrics.status)}${metrics.reason ? ` · ${safe(metrics.reason)}` : ''}`,
    '',
    '| 指标 | 本轮 |',
    '| --- | ---: |',
    `| 采集候选数 | ${count(metrics.candidates)} |`,
    `| 通过初筛数 | ${count(metrics.qualified)} |`,
    ...(metrics.finalists === undefined
      ? []
      : [`| 进入 AI 审查数 | ${count(metrics.finalists)} |`]),
    `| 入榜数 | ${count(metrics.published)} |`,
    ...(metrics.rejected === undefined
      ? []
      : [`| 内容评分未通过 | ${count(metrics.rejected)} |`]),
    ...(metrics.failed === undefined
      ? []
      : [`| 技术处理失败 | ${count(metrics.failed)} |`]),
    `| AI 请求尝试数（含失败） | ${count(metrics.aiCalls)} |`,
    `| Arctic 请求尝试数 | ${count(metrics.requests)} |`,
    `| 最近响应的限流剩余额度 | ${count(metrics.remaining)} |`,
    '',
    '未取得不代表 0；限流额度来自响应标头，不估算。此摘要不包含正文、提示词或凭证。',
    '',
  ].join('\n');
}
export async function writeWorkflowSummary(
  kind: string,
  metrics: WorkflowMetrics,
) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      workflowSummary(kind, metrics),
      'utf8',
    );
}
export async function skipHourlyFallback() {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, 'skip_fallback=true\n', 'utf8');
}
