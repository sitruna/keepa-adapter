import { ADAPTER_VERSION, SOURCE, CSV_TYPE, KEEPA_DOMAINS } from "../constants.js";
import type { UniversalEnvelope, ProductSnapshot } from "../schema/universal.js";
import type { TokenMeta } from "./client.js";
import type { KeepaProduct } from "../schema/keepa.js";
import { getLatestCsvValue } from "./keepa-csv.js";

// --- Envelope builders ---

export function toUniversalEnvelope(
  dataType: string,
  data: unknown,
  opts?: {
    marketplace?: string | null;
    tokens?: TokenMeta;
  }
): UniversalEnvelope {
  return {
    source: SOURCE,
    adapter_version: ADAPTER_VERSION,
    data_type: dataType,
    marketplace: opts?.marketplace ?? null,
    retrieved_at: new Date().toISOString(),
    tokens: opts?.tokens,
    data,
  };
}

export function toErrorEnvelope(
  code: string,
  message: string,
  httpStatus?: number
): UniversalEnvelope {
  return {
    source: SOURCE,
    adapter_version: ADAPTER_VERSION,
    data_type: "error",
    retrieved_at: new Date().toISOString(),
    data: null,
    error: {
      code,
      message,
      http_status: httpStatus,
    },
  };
}

// --- Domain helpers ---

function domainName(domainId: number): string {
  for (const [name, id] of Object.entries(KEEPA_DOMAINS)) {
    if (id === domainId) return name;
  }
  return "com";
}

// --- Per-type transformers ---

export function transformProductSnapshot(
  raw: KeepaProduct,
  domain?: string
): ProductSnapshot {
  const csv = raw.csv ?? [];
  const domainStr = domain ?? domainName(raw.domainId);

  // Parse images
  const images: string[] = raw.imagesCSV
    ? raw.imagesCSV.split(",").filter(Boolean)
    : [];

  // Parse variation attributes from variationCSV
  let variationAttributes: Record<string, string> | null = null;
  if (raw.variationCSV) {
    variationAttributes = {};
    const parts = raw.variationCSV.split(",");
    for (let i = 0; i < parts.length - 1; i += 2) {
      if (parts[i] && parts[i + 1]) {
        variationAttributes[parts[i]] = parts[i + 1];
      }
    }
    if (Object.keys(variationAttributes).length === 0) {
      variationAttributes = null;
    }
  }

  // Buy box info
  const buyBoxHistory = raw.buyBoxSellerIdHistory ?? raw.stats?.buyBoxSellerIdHistory;
  const buyBoxSellerId = buyBoxHistory?.length
    ? buyBoxHistory[buyBoxHistory.length - 1] ?? null
    : null;

  return {
    asin: raw.asin,
    domain: domainStr,
    title: raw.title ?? null,
    brand: raw.brand ?? null,
    amazon_price: getLatestCsvValue(csv[CSV_TYPE.AMAZON], { isPriceCents: true }),
    new_price: getLatestCsvValue(csv[CSV_TYPE.NEW], { isPriceCents: true }),
    sales_rank: getLatestCsvValue(csv[CSV_TYPE.SALES_RANK]),
    rating: getLatestCsvValue(csv[CSV_TYPE.RATING], { isPriceCents: false }),
    review_count: getLatestCsvValue(csv[CSV_TYPE.COUNT_REVIEWS]),
    buy_box_seller_id: buyBoxSellerId,
    buy_box_is_amazon: buyBoxSellerId === "ATVPDKIKX0DER" ? true : buyBoxSellerId ? false : null,
    buy_box_price: getLatestCsvValue(csv[CSV_TYPE.BUY_BOX_SHIPPING], { isPriceCents: true }),
    images,
    features: raw.features ?? [],
    description: raw.description ?? null,
    parent_asin: raw.parentAsin ?? null,
    child_asins: [],
    variation_attributes: variationAttributes,
  };
}

export function transformBuyBox(raw: KeepaProduct) {
  const buyBoxHistory = raw.buyBoxSellerIdHistory ?? raw.stats?.buyBoxSellerIdHistory ?? [];
  const csv = raw.csv ?? [];

  return {
    asin: raw.asin,
    current_seller_id: buyBoxHistory.length
      ? buyBoxHistory[buyBoxHistory.length - 1] ?? null
      : null,
    is_amazon:
      buyBoxHistory.length && buyBoxHistory[buyBoxHistory.length - 1] === "ATVPDKIKX0DER"
        ? true
        : false,
    buy_box_price: getLatestCsvValue(csv[CSV_TYPE.BUY_BOX_SHIPPING], { isPriceCents: true }),
    offers: (raw.offers ?? []).map((o) => ({
      seller_id: o.sellerId ?? null,
      seller_name: o.sellerName ?? null,
      is_fba: o.isFBA ?? null,
      is_prime: o.isPrime ?? null,
      is_buy_box_winner: o.isBuyBoxWinner ?? null,
      condition: o.condition ?? null,
    })),
  };
}

export function transformVariationFamily(raw: KeepaProduct) {
  let attributes: Record<string, string> | null = null;
  if (raw.variationCSV) {
    attributes = {};
    const parts = raw.variationCSV.split(",");
    for (let i = 0; i < parts.length - 1; i += 2) {
      if (parts[i] && parts[i + 1]) {
        attributes[parts[i]] = parts[i + 1];
      }
    }
    if (Object.keys(attributes).length === 0) attributes = null;
  }

  return {
    asin: raw.asin,
    parent_asin: raw.parentAsin ?? null,
    variation_attributes: attributes,
  };
}
