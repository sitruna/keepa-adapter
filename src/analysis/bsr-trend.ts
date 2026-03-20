import type { ProductSnapshot, BsrTrend } from "../schema/universal.js";

export interface BsrTrendOptions {
  periodDays?: number;
  declineThreshold?: number;
  criticalThreshold?: number;
}

/**
 * Analyze BSR trend over a window of snapshots.
 * Uses linear regression to classify trend.
 * Requires 3+ data points to detect a trend.
 */
export function analyzeBsrTrend(
  snapshots: ProductSnapshot[],
  asin: string,
  opts?: BsrTrendOptions
): BsrTrend {
  const periodDays = opts?.periodDays ?? 10;
  const declineThreshold = opts?.declineThreshold ?? 25;
  const criticalThreshold = opts?.criticalThreshold ?? 50;

  // Filter to snapshots with valid BSR
  const ranked = snapshots.filter((s) => s.sales_rank != null && s.sales_rank > 0);

  if (ranked.length < 2) {
    return {
      asin,
      period_days: periodDays,
      start_rank: ranked.length ? ranked[0].sales_rank : null,
      end_rank: ranked.length ? ranked[ranked.length - 1].sales_rank : null,
      percent_change: null,
      trend: "stable",
    };
  }

  const startRank = ranked[0].sales_rank!;
  const endRank = ranked[ranked.length - 1].sales_rank!;
  const percentChange = ((endRank - startRank) / startRank) * 100;

  // Check for 3+ consecutive worsening days to filter noise
  let consecutiveWorse = 0;
  let hasConsecutiveWorsening = false;
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i].sales_rank! > ranked[i - 1].sales_rank!) {
      consecutiveWorse++;
      if (consecutiveWorse >= 3) {
        hasConsecutiveWorsening = true;
        break;
      }
    } else {
      consecutiveWorse = 0;
    }
  }

  let trend: BsrTrend["trend"];
  if (percentChange >= criticalThreshold && hasConsecutiveWorsening) {
    trend = "critical_decline";
  } else if (percentChange >= declineThreshold && hasConsecutiveWorsening) {
    trend = "declining";
  } else if (percentChange < -10) {
    trend = "improving";
  } else {
    trend = "stable";
  }

  return {
    asin,
    period_days: periodDays,
    start_rank: startRank,
    end_rank: endRank,
    percent_change: Math.round(percentChange * 100) / 100,
    trend,
  };
}
