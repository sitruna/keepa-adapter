import { describe, it, expect } from "vitest";
import { transformProductSnapshot } from "../../src/adapter/transformer.js";
import type { KeepaProduct } from "../../src/schema/keepa.js";

function base(overrides: Partial<KeepaProduct> = {}): KeepaProduct {
  return {
    asin: "B07KS958KC",
    domainId: 2,
    title: "Test Product",
    brand: "TestBrand",
    csv: [[0, 5699], [0, 5699], null, [0, 12345]],
    imagesCSV: null,
    ...overrides,
  } as KeepaProduct;
}

// ── Brand store ────────────────────────────────────────────────────────────────

describe("brand store fields", () => {
  it("maps brandStoreName / brandStoreUrlName / brandStoreUrl from raw", () => {
    const raw = base({
      brandStoreName: "Silentnight",
      brandStoreUrlName: "silentnight",
      brandStoreUrl: "https://www.amazon.co.uk/stores/silentnight",
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.brand_store_name).toBe("Silentnight");
    expect(snap.brand_store_url_name).toBe("silentnight");
    expect(snap.brand_store_url).toBe("https://www.amazon.co.uk/stores/silentnight");
  });

  it("returns null for missing brand store fields", () => {
    const snap = transformProductSnapshot(base(), "uk");
    expect(snap.brand_store_name).toBeNull();
    expect(snap.brand_store_url_name).toBeNull();
    expect(snap.brand_store_url).toBeNull();
  });
});

// ── Images fallback chain ──────────────────────────────────────────────────────

const IMG_BASE = "https://m.media-amazon.com/images/I/";

describe("images fallback chain", () => {
  it("uses imagesCSV when present and constructs full URLs", () => {
    const raw = base({ imagesCSV: "ABCDEF.jpg,GHIJKL.jpg" });
    expect(transformProductSnapshot(raw, "uk").images).toEqual([
      `${IMG_BASE}ABCDEF.jpg`,
      `${IMG_BASE}GHIJKL.jpg`,
    ]);
  });

  it("falls back to images[] strings and constructs full URLs", () => {
    const raw = base({ imagesCSV: null, images: ["IMG001.jpg", "IMG002.jpg"] });
    expect(transformProductSnapshot(raw, "uk").images).toEqual([
      `${IMG_BASE}IMG001.jpg`,
      `${IMG_BASE}IMG002.jpg`,
    ]);
  });

  it("extracts filename from Keepa image objects (l/m keys) and constructs full URLs", () => {
    const raw = base({
      imagesCSV: null,
      images: [
        { l: "81HOpBWe9kL.jpg", lH: 2000, lW: 2000, m: "41ra0W-urNL.jpg", mH: 500, mW: 500 },
        { l: "71txgBrIyQL.jpg", lH: 2000, lW: 2001, m: "4103PDxF1eL.jpg", mH: 500, mW: 500 },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.images).toEqual([
      `${IMG_BASE}81HOpBWe9kL.jpg`,
      `${IMG_BASE}71txgBrIyQL.jpg`,
    ]);
  });

  it("passes through images that are already full URLs", () => {
    const raw = base({
      imagesCSV: null,
      images: ["https://m.media-amazon.com/images/I/existing.jpg"],
    });
    expect(transformProductSnapshot(raw, "uk").images).toEqual([
      "https://m.media-amazon.com/images/I/existing.jpg",
    ]);
  });

  it("falls back to variations[].image when imagesCSV and images[] both absent", () => {
    const raw = base({
      imagesCSV: null,
      images: undefined,
      variations: [
        { asin: "B07KS958KC", image: "VARIATION_IMG.jpg" },
        { asin: "B07KS958KD", image: "VARIATION_IMG2.jpg" },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.images).toContain(`${IMG_BASE}VARIATION_IMG.jpg`);
  });

  it("returns empty array when all image sources are absent", () => {
    const raw = base({ imagesCSV: null, images: undefined, variations: undefined });
    expect(transformProductSnapshot(raw, "uk").images).toEqual([]);
  });
});

// ── Offers normalisation ───────────────────────────────────────────────────────

describe("offers normalisation", () => {
  const recentKeepaTime = Math.floor((Date.now() - 1293840000000) / 60000);

  it("normalises FBA and FBM offers with correct counts", () => {
    const raw = base({
      offers: [
        { sellerId: "A1FBA", isFBA: true, isPrime: true, isBuyBoxWinner: true,
          condition: 1, lastSeen: recentKeepaTime, price: 5699, shipping: 0 },
        { sellerId: "A2FBM", isFBA: false, isPrime: false, isBuyBoxWinner: false,
          condition: 1, lastSeen: recentKeepaTime, price: 5999, shipping: 299 },
        { sellerId: "A3FBA", isFBA: true, isPrime: true, isBuyBoxWinner: false,
          condition: 1, lastSeen: recentKeepaTime, price: 6199, shipping: 0 },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.offer_count_fba).toBe(2);
    expect(snap.offer_count_fbm).toBe(1);
    expect(snap.offers).toHaveLength(3);
    const fbaOffer = snap.offers.find((o) => o.seller_id === "A1FBA")!;
    expect(fbaOffer.is_fba).toBe(true);
    expect(fbaOffer.is_fbm).toBe(false);
    expect(fbaOffer.price).toBe(56.99);
    expect(fbaOffer.is_buy_box_winner).toBe(true);
    expect(fbaOffer.currency).toBe("GBP");
    expect(fbaOffer.country).toBe("GB");
    expect(fbaOffer.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const fbmOffer = snap.offers.find((o) => o.seller_id === "A2FBM")!;
    expect(fbmOffer.is_fba).toBe(false);
    expect(fbmOffer.is_fbm).toBe(true);
  });

  it("falls back to stats offer counts when offers array is empty", () => {
    const raw = base({
      offers: [],
      stats: { current: [], offerCountFBA: 3, offerCountFBM: 2 },
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.offer_count_fba).toBe(3);
    expect(snap.offer_count_fbm).toBe(2);
    expect(snap.offers).toHaveLength(0);
  });

  it("decodes price from offerCSV when direct price field absent", () => {
    const raw = base({
      offers: [
        { sellerId: "A1", isFBA: true, condition: 1, lastSeen: recentKeepaTime,
          offerCSV: [recentKeepaTime - 100, 4999, recentKeepaTime, 5499] },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.offers[0].price).toBe(54.99);
  });

  it("sets currency and country correctly per domain", () => {
    const raw = base({ offers: [{ sellerId: "A1", isFBA: true, condition: 1 }] });
    const snapUk = transformProductSnapshot(raw, "uk");
    expect(snapUk.offers[0].currency).toBe("GBP");
    expect(snapUk.offers[0].country).toBe("GB");
    const snapCom = transformProductSnapshot({ ...raw, domainId: 1 }, "com");
    expect(snapCom.offers[0].currency).toBe("USD");
    expect(snapCom.offers[0].country).toBe("US");
  });
});

// ── A+ content ────────────────────────────────────────────────────────────────

describe("aplus_content and brand_story", () => {
  it("parses aPlus modules using the real Keepa field name", () => {
    const raw = base({
      aPlus: [
        {
          fromManufacturer: false,
          module: [
            {
              image: ["https://m.media-amazon.com/images/S/aplus-media/img1.png"],
              imageAltText: ["Alt text for image"],
            },
            {
              image: ["https://m.media-amazon.com/images/S/aplus-media/img2.png"],
              imageAltText: ["Second image alt"],
            },
          ],
        },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.aplus_content).toHaveLength(2);
    expect(snap.aplus_content[0].images).toEqual([
      "https://m.media-amazon.com/images/S/aplus-media/img1.png",
    ]);
    expect(snap.aplus_content[0].is_brand_story).toBe(false);
    expect(snap.aplus_content[0].module_type).toBeNull();
  });

  it("detects brand story when moduleType prefix is present", () => {
    const raw = base({
      aPlus: [
        {
          fromManufacturer: false,
          module: [
            { moduleType: "STANDARD_FOUR_IMAGE_TEXT", image: ["https://example.com/a.jpg"] },
            { moduleType: "BRAND_STORY_HERO_IMAGE", image: ["https://example.com/b.jpg"] },
          ],
        },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.aplus_content).toHaveLength(1);
    expect(snap.aplus_content[0].module_type).toBe("STANDARD_FOUR_IMAGE_TEXT");
    expect(snap.brand_story).toHaveLength(1);
    expect(snap.brand_story![0].module_type).toBe("BRAND_STORY_HERO_IMAGE");
    expect(snap.brand_story![0].is_brand_story).toBe(true);
  });

  it("returns empty aplus_content and null brand_story when no A+ data", () => {
    const snap = transformProductSnapshot(base(), "uk");
    expect(snap.aplus_content).toEqual([]);
    expect(snap.brand_story).toBeNull();
  });

  it("returns null brand_story when no brand story modules exist", () => {
    const raw = base({
      aPlus: [
        {
          fromManufacturer: false,
          module: [{ image: ["https://example.com/x.jpg"] }],
        },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.aplus_content).toHaveLength(1);
    expect(snap.brand_story).toBeNull();
  });
});

// ── Videos ────────────────────────────────────────────────────────────────────

describe("videos", () => {
  it("normalises videos array", () => {
    const raw = base({
      videos: [
        {
          title: "Product Demo",
          url: "https://example.com/video.mp4",
          durationSeconds: 62,
          thumbnailUrl: "https://example.com/thumb.jpg",
          creator: "BrandX",
        },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.videos).toHaveLength(1);
    expect(snap.videos[0].title).toBe("Product Demo");
    expect(snap.videos[0].url).toBe("https://example.com/video.mp4");
    expect(snap.videos[0].duration_seconds).toBe(62);
    expect(snap.videos[0].thumbnail_url).toBe("https://example.com/thumb.jpg");
    expect(snap.videos[0].creator).toBe("BrandX");
  });

  it("returns empty array when no videos", () => {
    const snap = transformProductSnapshot(base(), "uk");
    expect(snap.videos).toEqual([]);
  });

  it("handles null video fields gracefully", () => {
    const raw = base({
      videos: [{ title: null, url: "https://example.com/v.mp4" }],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.videos[0].title).toBeNull();
    expect(snap.videos[0].duration_seconds).toBeNull();
    expect(snap.videos[0].thumbnail_url).toBeNull();
    expect(snap.videos[0].creator).toBeNull();
  });
});
