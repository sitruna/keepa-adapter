import { keepaTimeToISO } from "./keepa-time.js";

export interface TimeSeriesPoint {
  timestamp: string;
  value: number | null;
}

// Keepa sentinels: -1 = never tracked, -2 = out of stock / no offer / not collected.
// Both indicate "no valid value" and should surface as null rather than leaking
// into the output (e.g. -2 cents becoming -0.02).
// For price fields, 0 is an additional sentinel meaning "price not tracked for this
// interval" (distinct from a genuine £0.00 which never occurs on Amazon).
function isSentinel(value: number, isPriceCents?: boolean): boolean {
  if (value === -1 || value === -2) return true;
  if (isPriceCents && value === 0) return true;
  return false;
}

/**
 * Decode Keepa's flat CSV array into a time series.
 * Format: [keepaTime0, value0, keepaTime1, value1, ...]
 * Values of -1 (no data) or -2 (OOS / no offer) mean null.
 * If `isPriceCents` is true, values are converted from cents to dollars.
 */
export function decodeCsvTimeSeries(
  csv: number[] | null | undefined,
  opts?: { isPriceCents?: boolean }
): TimeSeriesPoint[] {
  if (!csv || csv.length < 2) return [];

  const isPriceCents = opts?.isPriceCents ?? false;
  const points: TimeSeriesPoint[] = [];

  for (let i = 0; i < csv.length - 1; i += 2) {
    const keepaTime = csv[i];
    const rawValue = csv[i + 1];

    const value = isSentinel(rawValue, isPriceCents)
      ? null
      : isPriceCents
        ? rawValue / 100
        : rawValue;

    points.push({
      timestamp: keepaTimeToISO(keepaTime),
      value,
    });
  }

  return points;
}

export interface CouponTimeSeriesPoint {
  timestamp: string;
  absolute_discount: number | null;
  percent_discount: number | null;
}

/**
 * Decode Keepa's coupon history triplet format.
 * Format: [keepaTime0, absoluteDiscount0, percentDiscount0, keepaTime1, ...]
 * absoluteDiscount: cents off (0 = no absolute discount)
 * percentDiscount: negative = percent off (e.g. -10 = 10% off), 0 = coupon removed
 * Both 0 = coupon removed.
 */
export function decodeCouponTimeSeries(
  csv: number[] | null | undefined
): CouponTimeSeriesPoint[] {
  if (!csv || csv.length < 3) return [];

  const points: CouponTimeSeriesPoint[] = [];

  for (let i = 0; i < csv.length - 2; i += 3) {
    const keepaTime = csv[i];
    const absoluteRaw = csv[i + 1];
    const percentRaw = csv[i + 2];

    // Both 0 means coupon was removed
    const removed = absoluteRaw === 0 && percentRaw === 0;

    points.push({
      timestamp: keepaTimeToISO(keepaTime),
      absolute_discount: removed
        ? null
        : absoluteRaw === 0
          ? null
          : absoluteRaw / 100,
      percent_discount: removed
        ? null
        : percentRaw === 0
          ? null
          : Math.abs(percentRaw),
    });
  }

  return points;
}

/**
 * Get the latest value from a Keepa CSV array.
 * Returns null for sentinel values (-1 no data, -2 OOS / no offer).
 */
export function getLatestCsvValue(
  csv: number[] | null | undefined,
  opts?: { isPriceCents?: boolean }
): number | null {
  if (!csv || csv.length < 2) return null;
  const rawValue = csv[csv.length - 1];
  if (isSentinel(rawValue, opts?.isPriceCents)) return null;
  return opts?.isPriceCents ? rawValue / 100 : rawValue;
}
