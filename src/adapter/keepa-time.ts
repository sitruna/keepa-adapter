import { KEEPA_EPOCH_MS } from "../constants.js";

/** Convert Keepa time (minutes since 2011-01-01) to a Date */
export function keepaTimeToDate(minutes: number): Date {
  return new Date(KEEPA_EPOCH_MS + minutes * 60_000);
}

/** Convert Keepa time (minutes since 2011-01-01) to ISO 8601 string */
export function keepaTimeToISO(minutes: number): string {
  return keepaTimeToDate(minutes).toISOString();
}

/** Convert a Date to Keepa time (minutes since 2011-01-01) */
export function dateToKeepaTime(date: Date): number {
  return Math.floor((date.getTime() - KEEPA_EPOCH_MS) / 60_000);
}
