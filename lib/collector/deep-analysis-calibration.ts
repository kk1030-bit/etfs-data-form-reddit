import type { DeepAiScores } from './deep-analysis-ai.ts';

export type CalibrationRow = {
  id: string;
  rubricVersion: string;
  status: string;
  features: Record<string, number>;
  scores?: DeepAiScores;
  total?: number;
  aiCalls: number;
};

/** Descriptive separation, not a trained model or automatic weight change. */
export function compareCalibration(rows: CalibrationRow[]) {
  const passed = rows.filter((r) => r.status === 'accepted');
  const rejected = rows.filter((r) => r.status === 'rejected');
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.features)))];
  const mean = (items: CalibrationRow[], key: string) => {
    const values = items.map((r) => r.features[key]).filter(Number.isFinite);
    return values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null;
  };
  const features = names
    .map((feature) => {
      const acceptedMean = mean(passed, feature),
        rejectedMean = mean(rejected, feature);
      return {
        feature,
        acceptedMean,
        rejectedMean,
        difference:
          acceptedMean === null || rejectedMean === null
            ? null
            : acceptedMean - rejectedMean,
      };
    })
    .sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0));
  return {
    accepted: passed.length,
    rejected: rejected.length,
    technicalFailures: rows.filter((r) => r.status === 'failed').length,
    features,
    warning:
      'Descriptive sample comparison only; failed or quota-limited reviews are not editorial rejections. No automatic weight changes.',
  };
}
