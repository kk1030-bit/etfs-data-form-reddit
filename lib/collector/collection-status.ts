export type RunStage =
  | 'unknown'
  | 'preparing'
  | 'source'
  | 'ranking'
  | 'persistence'
  | 'analysis'
  | 'publishing'
  | 'completed';

export type AttemptRow = {
  logical_hour_utc: string;
  started_at_utc: string;
  completed_at_utc: string | null;
  status: string;
  stage: string;
  error: string | null;
  upstream_status: number | null;
  retry_at_utc: string | null;
};

export type CollectionAttempt = {
  logicalHour: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  stage: string;
  error: string | null;
  upstreamStatus: number | null;
  retryAt: string | null;
};

export type PipelineStep = {
  name: string;
  status:
    | 'completed'
    | 'running'
    | 'waiting'
    | 'failed'
    | 'not_run'
    | 'cooldown';
};

export function rollingWindow(nowMs: number): { start: string; end: string } {
  return {
    start: new Date(nowMs - 24 * 3_600_000).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
}

export function presentAttempt(
  row: AttemptRow | null,
  nowMs: number,
): CollectionAttempt | null {
  if (!row) return null;
  const rateLimited =
    row.upstream_status === 429 ||
    row.error?.startsWith('Reddit RSS rate limited');
  const timedOut =
    row.status === 'running' &&
    nowMs - Date.parse(row.started_at_utc) >= 20 * 60_000;
  let error: string | null = null;
  if (rateLimited)
    error = 'Reddit 暂时限制 RSS 请求（HTTP 429），本轮没有取得新数据。';
  else if (row.status === 'deferred')
    error = '另一轮 RSS 请求仍在处理中，本轮未重复请求。';
  else if (timedOut) error = '本轮超过 20 分钟未完成，请查看采集服务日志。';
  else if (row.error) {
    if (row.upstream_status)
      error = `Reddit 返回 HTTP ${row.upstream_status}，本轮采集已结束。`;
    else if (/timeout|timed out|aborted/i.test(row.error))
      error = '请求超时，本轮采集已结束。';
    else if (/D1|SQLITE|database/i.test(row.error))
      error = '资料库处理失败，请查看后台错误日志。';
    else if (/content-type|Atom|XML|redirect/i.test(row.error))
      error = 'Reddit 返回的内容格式或跳转未通过验证。';
    else if (/没有符合 ETF/.test(row.error))
      error = '本轮 RSS 没有符合 ETF 条件的候选贴文。';
    else error = '采集服务处理失败，请查看后台错误日志。';
  }
  return {
    logicalHour: row.logical_hour_utc,
    startedAt: row.started_at_utc,
    completedAt: row.completed_at_utc,
    status: timedOut ? 'failed' : row.status,
    stage: rateLimited ? 'source' : row.stage,
    error,
    upstreamStatus: rateLimited ? 429 : row.upstream_status,
    retryAt: row.retry_at_utc,
  };
}

export function collectionPipeline(
  attempt: CollectionAttempt | null,
  rss: boolean,
  analysisStatus: PipelineStep['status'] = 'completed',
): PipelineStep[] {
  const steps: Array<{ stage: RunStage; name: string }> = [
    { stage: 'source', name: rss ? '读取 Reddit RSS' : '发现 Reddit 帖子' },
    { stage: 'ranking', name: '来源验证与排名' },
    { stage: 'persistence', name: '入库与 24 小时追踪' },
    { stage: 'analysis', name: '简中翻译与摘要' },
    { stage: 'publishing', name: '发布小时榜单' },
  ];
  if (!attempt) return steps.map(({ name }) => ({ name, status: 'waiting' }));
  if (attempt.status === 'completed')
    return steps.map(({ name, stage }) => ({
      name,
      status:
        stage === 'analysis'
          ? analysisStatus === 'waiting'
            ? 'not_run'
            : analysisStatus
          : 'completed',
    }));
  const index = steps.findIndex((step) => step.stage === attempt.stage);
  const running = attempt.status === 'running';
  return steps.map(({ name }, i) => ({
    name,
    status:
      index < 0
        ? running
          ? 'waiting'
          : 'not_run'
        : i < index
          ? 'completed'
          : i > index
            ? running
              ? 'waiting'
              : 'not_run'
            : running
              ? 'running'
              : attempt.status === 'cooldown'
                ? 'cooldown'
                : attempt.status === 'deferred'
                  ? 'not_run'
                  : 'failed',
  }));
}
