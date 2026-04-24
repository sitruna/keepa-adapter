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

describe("images fallback chain", () => {
  it("uses imagesCSV when present", () => {
    const raw = base({ imagesCSV: "ABCDEF.jpg,GHIJKL.jpg" });
    expect(transformProductSnapshot(raw, "uk").images).toEqual(["ABCDEF.jpg", "GHIJKL.jpg"]);
  });

  it("falls back to images[] when imagesCSV is absent", () => {
    const raw = base({ imagesCSV: null, images: ["IMG001.jpg", "IMG002.jpg"] });
    expect(transformProductSnapshot(raw, "uk").images).toEqual(["IMG001.jpg", "IMG002.jpg"]);
  });

  it("falls back to variations[].image when imagesCSV and images[] both absent (B07KS958KC-like)", () => {
    const raw = base({
      imagesCSV: null,
      images: undefined,
      variations: [
        { asin: "B07KS958KC", image: "VARIATION_IMG.jpg" },
        { asin: "B07KS958KD", image: "VARIATION_IMG2.jpg" },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.images.length).toBeGreaterThan(0);
    expect(snap.images).toContain("VARIATION_IMG.jpg");
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
  it("parses A+ modules and separates brand story from content", () => {
    const raw = base({
      aPlusDocumentArray: [
        {
          asin: "B07KS958KC",
          moduleList: [
            {
              moduleType: "STANDARD_FOUR_IMAGE_TEXT",
              headline: "Great Features",
              body: "Body text here",
              imageList: [{ url: "https://example.com/img1.jpg" }],
            },
            {
              moduleType: "BRAND_STORY_HERO_IMAGE",
              headline: "Our Story",
              body: "Brand story text",
              imageList: [{ url: "https://example.com/hero.jpg" }],
            },
          ],
        },
      ],
    });
    const snap = transformProductSnapshot(raw, "uk");
    expect(snap.aplus_content).toHaveLength(1);
    expect(snap.aplus_content[0].module_type).toBe("STANDARD_FOUR_IMAGE_TEXT");
    expect(snap.aplus_content[0].heading).toBe("Great Features");
    expect(snap.aplus_content[0].body).toBe("Body text here");
    expect(snap.aplus_content[0].images).toEqual(["https://example.com/img1.jpg"]);
    expect(snap.aplus_content[0].is_brand_story).toBe(false);
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
      aPlusDocumentArray: [
        {
          asin: "B07KS958KC",
          moduleList: [
            { moduleType: "STANDARD_TECH_SPECS", headline: "Specs", body: "Details" },
          ],
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
