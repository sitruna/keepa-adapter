import { describe, it, expect } from "vitest";
import {
  keepaTimeToDate,
  keepaTimeToISO,
  dateToKeepaTime,
} from "../../src/adapter/keepa-time.js";

describe("keepa-time", () => {
  it("converts keepa time 0 to 2011-01-01T00:00:00.000Z", () => {
    expect(keepaTimeToISO(0)).toBe("2011-01-01T00:00:00.000Z");
  });

  it("converts keepa time to correct date", () => {
    // 60 minutes = 1 hour after epoch
    expect(keepaTimeToISO(60)).toBe("2011-01-01T01:00:00.000Z");
  });

  it("converts keepa time 1440 to 2011-01-02", () => {
    // 1440 minutes = 24 hours
    const date = keepaTimeToDate(1440);
    expect(date.getUTCFullYear()).toBe(2011);
    expect(date.getUTCMonth()).toBe(0); // January
    expect(date.getUTCDate()).toBe(2);
  });

  it("round-trips date to keepa time and back", () => {
    const original = new Date("2024-06-15T12:30:00.000Z");
    const keepaTime = dateToKeepaTime(original);
    const roundTripped = keepaTimeToDate(keepaTime);
    // Should be within 1 minute due to floor
    expect(Math.abs(roundTripped.getTime() - original.getTime())).toBeLessThan(60_000);
  });

  it("handles a known date: 2025-01-01", () => {
    const date = new Date("2025-01-01T00:00:00.000Z");
    const keepaTime = dateToKeepaTime(date);
    expect(keepaTime).toBeGreaterThan(0);
    const back = keepaTimeToISO(keepaTime);
    expect(back).toBe("2025-01-01T00:00:00.000Z");
  });
});
