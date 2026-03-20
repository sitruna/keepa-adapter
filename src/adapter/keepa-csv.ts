import { keepaTimeToISO } from "./keepa-time.js";

export interface TimeSeriesPoint {
  timestamp: string;
  value: number | null;
}

/**
 * Decode Keepa's flat CSV array into a time series.
 * Format: [keepaTime0, value0, keepaTime1, value1, ...]
 * Values of -1 mean no data (null).
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

    const value =
      rawValue === -1
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

/**
 * Get the latest value from a Keepa CSV array.
 * Returns null if no valid data.
 */
export function getLatestCsvValue(
  csv: number[] | null | undefined,
  opts?: { isPriceCents?: boolean }
): number | null {
  if (!csv || csv.length < 2) return null;
  const rawValue = csv[csv.length - 1];
  if (rawValue === -1) return null;
  return opts?.isPriceCents ? rawValue / 100 : rawValue;
}
