type JobKind = 'hourly' | 'daily' | 'weekly';

// A 2xx dispatch acknowledgement is not evidence of a completed collection.
// Log only protocol fields, never raw error bodies or upstream credentials.
export async function inspectSiteJobResponse(
  response: Response,
  kind: JobKind,
  log: (value: unknown) => void = console.log,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`Site job ${kind} failed: HTTP ${response.status}`);
  }
  let result: {
    status?: string;
    logicalTimeUtc?: string;
    scheduler?: { status?: string; attempts?: number; checkedAt?: string };
  };
  try {
    result = await response.json();
    if (
      !result ||
      !['completed', 'skipped', 'cooldown', 'deferred'].includes(
        result.status ?? '',
      )
    )
      throw new Error('Invalid job outcome');
  } catch {
    throw new Error(`Site job ${kind} returned an invalid outcome`);
  }
  const schedulerStatus = result.scheduler?.status;
  const safeSchedulerStatus =
    schedulerStatus &&
    [
      'waiting',
      'dispatched',
      'running',
      'completed',
      'cooldown',
      'failed',
      'unconfigured',
      'exhausted',
    ].includes(schedulerStatus)
      ? schedulerStatus
      : undefined;
  log({
    event: 'site_job_checked',
    kind,
    outcome: result.status,
    schedulerStatus: safeSchedulerStatus,
    dispatchAttempts: Number.isInteger(result.scheduler?.attempts)
      ? result.scheduler?.attempts
      : undefined,
  });
  if (
    safeSchedulerStatus &&
    ['failed', 'unconfigured', 'exhausted'].includes(safeSchedulerStatus)
  ) {
    throw new Error(`Hourly scheduler needs attention: ${safeSchedulerStatus}`);
  }
}
