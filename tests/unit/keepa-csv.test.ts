import { describe, it, expect } from "vitest";
import {
  decodeCsvTimeSeries,
  decodeCouponTimeSeries,
  getLatestCsvValue,
} from "../../src/adapter/keepa-csv.js";

describe("keepa-csv", () => {
  describe("decodeCsvTimeSeries", () => {
    it("returns empty array for null input", () => {
      expect(decodeCsvTimeSeries(null)).toEqual([]);
      expect(decodeCsvTimeSeries(undefined)).toEqual([]);
      expect(decodeCsvTimeSeries([])).toEqual([]);
    });

    it("decodes time series pairs", () => {
      const csv = [0, 1000, 60, 2000];
      const result = decodeCsvTimeSeries(csv);
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe("2011-01-01T00:00:00.000Z");
      expect(result[0].value).toBe(1000);
      expect(result[1].timestamp).toBe("2011-01-01T01:00:00.000Z");
      expect(result[1].value).toBe(2000);
    });

    it("converts -1 to null", () => {
      const csv = [0, -1, 60, 500];
      const result = decodeCsvTimeSeries(csv);
      expect(result[0].value).toBeNull();
      expect(result[1].value).toBe(500);
    });

    it("converts cents to dollars when isPriceCents is true", () => {
      const csv = [0, 1999, 60, 2499];
      const result = decodeCsvTimeSeries(csv, { isPriceCents: true });
      expect(result[0].value).toBe(19.99);
      expect(result[1].value).toBe(24.99);
    });

    it("preserves raw values when isPriceCents is false", () => {
      const csv = [0, 1999];
      const result = decodeCsvTimeSeries(csv, { isPriceCents: false });
      expect(result[0].value).toBe(1999);
    });
  });

  describe("decodeCouponTimeSeries", () => {
    it("returns empty array for null input", () => {
      expect(decodeCouponTimeSeries(null)).toEqual([]);
      expect(decodeCouponTimeSeries(undefined)).toEqual([]);
      expect(decodeCouponTimeSeries([])).toEqual([]);
    });

    it("decodes percent-off coupon triplet", () => {
      // [time, 0, -10] => 10% off, no absolute discount
      const csv = [0, 0, -10];
      const result = decodeCouponTimeSeries(csv);
      expect(result).toHaveLength(1);
      expect(result[0].percent_discount).toBe(10);
      expect(result[0].absolute_discount).toBeNull();
    });

    it("decodes absolute-off coupon triplet", () => {
      // [time, 500, 0] => $5.00 off, no percent discount
      const csv = [0, 500, 0];
      const result = decodeCouponTimeSeries(csv);
      expect(result).toHaveLength(1);
      expect(result[0].absolute_discount).toBe(5.00);
      expect(result[0].percent_discount).toBeNull();
    });

    it("decodes coupon removed (both zeros)", () => {
      const csv = [0, 0, 0];
      const result = decodeCouponTimeSeries(csv);
      expect(result).toHaveLength(1);
      expect(result[0].absolute_discount).toBeNull();
      expect(result[0].percent_discount).toBeNull();
    });

    it("handles multiple triplets", () => {
      const csv = [0, 0, -10, 60, 0, 0, 120, 300, -5];
      const result = decodeCouponTimeSeries(csv);
      expect(result).toHaveLength(3);
      expect(result[0].percent_discount).toBe(10);
      expect(result[1].percent_discount).toBeNull(); // removed
      expect(result[2].absolute_discount).toBe(3.00);
      expect(result[2].percent_discount).toBe(5);
    });
  });

  describe("getLatestCsvValue", () => {
    it("returns null for empty/null input", () => {
      expect(getLatestCsvValue(null)).toBeNull();
      expect(getLatestCsvValue(undefined)).toBeNull();
      expect(getLatestCsvValue([])).toBeNull();
    });

    it("returns last value", () => {
      const csv = [0, 1000, 60, 2000];
      expect(getLatestCsvValue(csv)).toBe(2000);
    });

    it("returns null if last value is -1", () => {
      const csv = [0, 1000, 60, -1];
      expect(getLatestCsvValue(csv)).toBeNull();
    });

    it("converts cents to dollars", () => {
      const csv = [0, 1000, 60, 2499];
      expect(getLatestCsvValue(csv, { isPriceCents: true })).toBe(24.99);
    });
  });
});
