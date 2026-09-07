import type { CollectionAttempt } from './collection-status.ts';
import type { SchedulerCheck } from './scheduler-watchdog.ts';

const HOUR_MS = 3_600_000;
const DEADLINE_MINUTE = 25;

export type SchedulerStatus = {
  latestCheck: SchedulerCheck | null;
  currentHour: string;
  expectedHour: string;
  deadlineAt: string;
  nextExpectedAt: string;
  nextCheckAt: string;
  currentHourCompleted: boolean;
  isOverdue: boolean;
  configured: boolean | null;
  checkUnavailable: boolean;
  checkStale: boolean;
  needsAttention: boolean;
  message: string;
  checkLabel: string;
  checkMessage: string;
};

type SchedulerStatusInput = {
  nowMs: number;
  lastCompletedHour: string | null;
  latestAttempt: CollectionAttempt | null;
  latestCheck: SchedulerCheck | null;
  checkReadFailed?: boolean;
  cooldownUntil?: string | null;
};

const checkLabels: Record<SchedulerCheck['status'], string> = {
  waiting: '等待正常排程',
  dispatched: '已补触发，待采集完成',
  running: '采集任务排队或执行中',
  completed: '检查时已有完成记录',
  cooldown: '来源冷却中',
  failed: '排程检查或补触发失败',
  unconfigured: '补触发未配置',
  exhausted: '本小时补触发次数已用尽',
};

const checkMessages: Record<SchedulerCheck['status'], string> = {
  waiting: '等待 GitHub 每小时 :10 的正常排程；检查本身不会产生新榜单。',
  dispatched:
    'Cloudflare 已请求 GitHub 启动采集，尚不代表采集成功或资料已入库。',
  running: '采集任务或 GitHub 工作流正在排队或执行，等待实际采集与入库完成。',
  completed:
    '该次检查确认对应小时已有采集完成记录；本小时状态仍按实际资料所属小时判断。',
  cooldown: '来源处于冷却期，检查会继续进行；这次检查没有完成新采集。',
  failed: 'Cloudflare 未能完成排程检查或补触发，请查看采集服务日志。',
  unconfigured:
    '需要配置专用 GitHub Actions token（GITHUB_ACTIONS_TOKEN）以启用补触发；正常的 GitHub :10 排程仍独立运行。',
  exhausted:
    '本小时允许的补触发次数已用尽，仍未确认采集完成，请检查 GitHub Actions。',
};

/** Dashboard freshness follows the dataset's logical hour, never its import time. */
export function schedulerStatus({
  nowMs,
  lastCompletedHour,
  latestAttempt,
  latestCheck,
  checkReadFailed = false,
  cooldownUntil,
}: SchedulerStatusInput): SchedulerStatus {
  const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const deadlineMs = currentHourMs + DEADLINE_MINUTE * 60_000;
  const expectedHourMs =
    nowMs < deadlineMs ? currentHourMs - HOUR_MS : currentHourMs;
  const completedHourMs = lastCompletedHour
    ? Date.parse(lastCompletedHour)
    : NaN;
  const validCompletedHour =
    Number.isFinite(completedHourMs) && completedHourMs <= currentHourMs;
  const currentHourCompleted =
    validCompletedHour && completedHourMs === currentHourMs;
  const isOverdue = !validCompletedHour || completedHourMs < expectedHourMs;
  const checkUnavailable = checkReadFailed || !latestCheck;
  const latestDueCheckMs =
    [50, 25, 0]
      .map((minute) => currentHourMs + minute * 60_000)
      .find((time) => time + 5 * 60_000 <= nowMs) ??
    currentHourMs - 10 * 60_000;
  const checkStale = Boolean(
    latestCheck &&
    (!Number.isFinite(Date.parse(latestCheck.checkedAt)) ||
      !Number.isFinite(Date.parse(latestCheck.logicalHour)) ||
      Date.parse(latestCheck.checkedAt) < latestDueCheckMs ||
      Date.parse(latestCheck.checkedAt) > nowMs ||
      Date.parse(latestCheck.logicalHour) > currentHourMs ||
      Date.parse(latestCheck.logicalHour) <
        Math.floor(latestDueCheckMs / HOUR_MS) * HOUR_MS),
  );
  const configured =
    latestCheck?.status === 'unconfigured'
      ? false
      : latestCheck?.lastDispatchAt || latestCheck?.status === 'dispatched'
        ? true
        : null;
  const activeAttempt =
    latestAttempt && Date.parse(latestAttempt.logicalHour) === currentHourMs
      ? latestAttempt
      : null;
  const currentCheck =
    latestCheck && Date.parse(latestCheck.logicalHour) === currentHourMs
      ? latestCheck
      : null;
  const inCooldown = Boolean(
    cooldownUntil && Date.parse(cooldownUntil) > nowMs,
  );
  let message = currentHourCompleted
    ? '本小时采集已完成。'
    : activeAttempt?.status === 'running' || currentCheck?.status === 'running'
      ? '本小时采集正在排队或执行，等待实际采集与入库完成。'
      : currentCheck?.status === 'dispatched'
        ? '本小时已补触发采集，等待实际采集与入库完成。'
        : inCooldown
          ? '来源仍在冷却，本小时尚未完成；冷却结束后由排程检查重试。'
          : activeAttempt?.status === 'failed'
            ? '本小时采集失败，等待后续排程检查。'
            : '本小时采集待完成；GitHub 每小时 :10 排程，Cloudflare :25 检查缺口并补触发。';
  if (isOverdue)
    message = `应完成小时已超过 :25，仍无采集完成记录，标记为漏跑／待完成。${message}`;

  const checkMessage = checkReadFailed
    ? '排程检查状态暂不可用（scheduler status unavailable）；已保留现有榜单，请稍后刷新。'
    : !latestCheck
      ? '尚无 Cloudflare 排程检查记录，无法确认检查是否执行；请核对采集器排程。'
      : `${checkStale ? '最近应执行的排程检查尚无新记录，以下为较早检查结果。' : ''}${checkMessages[latestCheck.status]}`;
  const nextNormalRunMs = currentHourMs + 10 * 60_000;
  const nextCheckMs = [25, 50, 60]
    .map((minute) => currentHourMs + minute * 60_000)
    .find((time) => time > nowMs)!;

  return {
    latestCheck,
    currentHour: new Date(currentHourMs).toISOString(),
    expectedHour: new Date(expectedHourMs).toISOString(),
    deadlineAt: new Date(
      expectedHourMs + DEADLINE_MINUTE * 60_000,
    ).toISOString(),
    nextExpectedAt: new Date(
      nowMs < nextNormalRunMs ? nextNormalRunMs : nextNormalRunMs + HOUR_MS,
    ).toISOString(),
    nextCheckAt: new Date(nextCheckMs).toISOString(),
    currentHourCompleted,
    isOverdue,
    configured,
    checkUnavailable,
    checkStale,
    needsAttention:
      isOverdue ||
      checkUnavailable ||
      checkStale ||
      configured === false ||
      Boolean(
        currentCheck && ['failed', 'exhausted'].includes(currentCheck.status),
      ),
    message,
    checkLabel: latestCheck ? checkLabels[latestCheck.status] : '暂无检查记录',
    checkMessage,
  };
}
