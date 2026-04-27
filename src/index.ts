import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type RequestHandler } from "express";
import { z } from "zod";

import { KeepaClient, KeepaApiError } from "./adapter/client.js";
import { getProduct, getTokenStatus, getBestSellers, getCategoryLookup } from "./adapter/endpoints.js";
import {
  toUniversalEnvelope,
  toErrorEnvelope,
  transformProductSnapshot,
  transformBuyBox,
  transformVariationFamily,
  transformSalesHistory,
  transformDeals,
  transformSellerStats,
} from "./adapter/transformer.js";
import { decodeCsvTimeSeries } from "./adapter/keepa-csv.js";
import { CSV_TYPE, DEFAULT_DOMAIN } from "./constants.js";
import { initDb } from "./storage/db.js";
import { insertSnapshot, getLatestSnapshot, getSnapshotHistory } from "./storage/snapshots.js";
import { insertChange, getRecentChanges } from "./storage/changes.js";
import { addTrackedAsin, listTrackedAsins } from "./storage/tracked-asins.js";
import { insertPromo, listPromos } from "./storage/promos.js";
import { detectChanges } from "./analysis/change-detection.js";
import { analyzeBsrTrend } from "./analysis/bsr-trend.js";
import { checkVariationChanges } from "./analysis/variation-monitor.js";
import { analyzePromoImpact } from "./analysis/promo-correlation.js";

const client = new KeepaClient();

let db: ReturnType<typeof initDb> | null = null;
let storageAvailable = false;
try {
  db = initDb();
  storageAvailable = true;
} catch (err) {
  console.error("[keepa-adapter] Storage init failed — monitoring tools disabled:", err);
}

function createMcpServer(): McpServer {
const server = new McpServer({
  name: "keepa-adapter",
  version: "1.0.0",
});

function errorResult(err: unknown) {
  const envelope =
    err instanceof KeepaApiError
      ? toErrorEnvelope(
          `keepa_${err.httpStatus}`,
          err.message,
          err.httpStatus
        )
      : toErrorEnvelope(
          "adapter_error",
          err instanceof Error ? err.message : "Unknown error"
        );
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

function storageUnavailableResult() {
  const envelope = toErrorEnvelope(
    "storage_unavailable",
    "Storage unavailable on this deployment. This tool requires a persistent volume mounted at /data on Railway."
  );
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

// =====================
// Read Tools (5)
// =====================

// Default projection for keepa_get_product_slim — the 10 fields most skills
// actually use. Drops description/features/subcategory_ranks/images/variations
// which together account for ~85% of per-product response size. Override by
// passing an explicit `fields` array.
const SLIM_DEFAULT_FIELDS = [
  "asin",
  "title",
  "brand",
  "new_price",
  "sales_rank",
  "rating",
  "review_count",
  "monthly_sold",
  "offer_count_fba",
  "offer_count_fbm",
] as const;

// --- 1. Get Product ---
server.tool(
  "keepa_get_product",
  "Fetch current product data for 1-100 ASINs from Keepa. Returns title, brand, prices, BSR, rating, buy box, images, features, variations. NOTE: default response shape is ~3 KB per product (~75 KB for 25 ASINs — exceeds MCP response-token limit). If you only need top-level metrics, prefer keepa_get_product_slim which drops description/features/subcategory_ranks/images by default.",
  {
    asins: z.array(z.string()).min(1).max(100).describe("ASINs to look up (1-100)"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
    stats_days: z.number().int().optional().describe("Number of days for stats (default: 30)"),
  },
  async ({ asins, domain, stats_days }) => {
    try {
      const res = await getProduct(client, {
        asins,
        domain: domain ?? DEFAULT_DOMAIN,
        stats: stats_days ?? 30,
        rating: true,
        buybox: true,
        offers: 20,
        aplus: true,
        videos: true,
      });
          // Strip out_of_stock_percentage_* from MCP output. Fields are still
      // populated internally for storage and change-detection use.
      const products = (res.data.products ?? []).map((p) => {
        const {
          out_of_stock_percentage_30: _oos30,
          out_of_stock_percentage_90: _oos90,
          ...rest
        } = transformProductSnapshot(p, domain);
        return rest;
      });
      const envelope = toUniversalEnvelope("product_snapshot", products, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 1b. Get Product (slim) ---
server.tool(
  "keepa_get_product_slim",
  "Slim variant of keepa_get_product. Returns only selected fields per ASIN — default projection covers the 10 fields most skills use (asin, title, brand, new_price, sales_rank, rating, review_count, monthly_sold, offer_count_fba, offer_count_fbm). Drops description/features/subcategory_ranks/images/variations by default. Typically ~85% smaller than keepa_get_product on 25-ASIN batches. Pass `fields` to override the projection (valid names match ProductSnapshot schema). Unknown field names are silently ignored.",
  {
    asins: z.array(z.string()).min(1).max(100).describe("ASINs to look up (1-100)"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
    stats_days: z.number().int().optional().describe("Number of days for stats (default: 30)"),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of field names to return per product. When omitted, uses the 10-field default projection."
      ),
  },
  async ({ asins, domain, stats_days, fields }) => {
    try {
      const res = await getProduct(client, {
        asins,
        domain: domain ?? DEFAULT_DOMAIN,
        stats: stats_days ?? 30,
        rating: true,
        buybox: true,
      });
      const selected =
        fields && fields.length > 0
          ? Array.from(new Set(fields))
          : [...SLIM_DEFAULT_FIELDS];
      const products = (res.data.products ?? []).map((p) => {
        const full = transformProductSnapshot(p, domain) as Record<string, unknown>;
        const slim: Record<string, unknown> = {};
        for (const key of selected) {
          if (Object.prototype.hasOwnProperty.call(full, key)) {
            slim[key] = full[key];
          }
        }
        return slim;
      });
      const envelope = toUniversalEnvelope("product_snapshot_slim", products, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 2. Get Price History ---
server.tool(
  "keepa_get_price_history",
  "Get price, rank, rating, and review history for ASINs. Returns time series data.",
  {
    asins: z.array(z.string()).min(1).max(100).describe("ASINs to get history for"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
    days: z.number().int().optional().describe("Number of days of history (default: 90)"),
  },
  async ({ asins, domain, days }) => {
    try {
      const res = await getProduct(client, {
        asins,
        domain: domain ?? DEFAULT_DOMAIN,
        stats: days ?? 90,
        history: true,
        rating: true,
      });
      const histories = (res.data.products ?? []).map((p) => {
        const csv = p.csv ?? [];
        return {
          asin: p.asin,
          amazon_price: decodeCsvTimeSeries(csv[CSV_TYPE.AMAZON], { isPriceCents: true }),
          new_price: decodeCsvTimeSeries(csv[CSV_TYPE.NEW], { isPriceCents: true }),
          used_price: decodeCsvTimeSeries(csv[CSV_TYPE.USED], { isPriceCents: true }),
          sales_rank: decodeCsvTimeSeries(csv[CSV_TYPE.SALES_RANK]),
          rating: decodeCsvTimeSeries(csv[CSV_TYPE.RATING]),
          review_count: decodeCsvTimeSeries(csv[CSV_TYPE.COUNT_REVIEWS]),
          buy_box_price: decodeCsvTimeSeries(csv[CSV_TYPE.BUY_BOX_SHIPPING], { isPriceCents: true }),
          list_price: decodeCsvTimeSeries(csv[CSV_TYPE.LIST_PRICE], { isPriceCents: true }),
          lightning_deal: decodeCsvTimeSeries(csv[CSV_TYPE.LIGHTNING_DEAL], { isPriceCents: true }),
          fba_price: decodeCsvTimeSeries(csv[CSV_TYPE.NEW_FBA], { isPriceCents: true }),
          fbm_price: decodeCsvTimeSeries(csv[CSV_TYPE.NEW_FBM_SHIPPING], { isPriceCents: true }),
          offer_count_new: decodeCsvTimeSeries(csv[CSV_TYPE.COUNT_NEW]),
          offer_count_used: decodeCsvTimeSeries(csv[CSV_TYPE.COUNT_USED]),
        };
      });
      const envelope = toUniversalEnvelope("price_history", histories, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 3. Get Buy Box ---
server.tool(
  "keepa_get_buy_box",
  "Get buy box ownership info including current seller, FBA status, and offers for ASINs.",
  {
    asins: z.array(z.string()).min(1).max(100).describe("ASINs to check buy box"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, domain }) => {
    try {
      const res = await getProduct(client, {
        asins,
        domain: domain ?? DEFAULT_DOMAIN,
        stats: 1,
        offers: 20,
        buybox: true,
      });
      const buyBoxes = (res.data.products ?? []).map(transformBuyBox);
      const envelope = toUniversalEnvelope("buy_box", buyBoxes, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 4. Get Variations ---
server.tool(
  "keepa_get_variations",
  "Get variation family tree for an ASIN including parent/child relationships and attributes.",
  {
    asin: z.string().describe("ASIN to get variation family for"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asin, domain }) => {
    try {
      const res = await getProduct(client, {
        asins: [asin],
        domain: domain ?? DEFAULT_DOMAIN,
        stats: 1,
      });
      const variations = (res.data.products ?? []).map(transformVariationFamily);
      const envelope = toUniversalEnvelope("variation_family", variations[0] ?? null, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 5. Check Tokens ---
server.tool(
  "keepa_check_tokens",
  "Check remaining Keepa API tokens and refresh rate.",
  {},
  async () => {
    try {
      const res = await getTokenStatus(client);
      const envelope = toUniversalEnvelope("token_status", {
        tokens_left: res.data.tokensLeft,
        refill_in_ms: res.data.refillIn,
        refill_rate: res.data.refillRate,
      }, { tokens: res.tokens });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =====================
// Monitoring Tools (5)
// =====================

// --- 6. Track ASINs ---
server.tool(
  "keepa_track_asins",
  "Add ASINs to the monitoring list for daily snapshot collection and change detection.",
  {
    asins: z.array(z.string()).min(1).describe("ASINs to track"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
    label: z.string().optional().describe("Label for this group of ASINs"),
    priority: z.enum(["critical", "standard", "weekly"]).optional().describe("Monitoring priority (default: standard)"),
  },
  async ({ asins, domain, label, priority }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      for (const asin of asins) {
        addTrackedAsin(db, {
          asin,
          domain: domain ?? DEFAULT_DOMAIN,
          label,
          priority,
        });
      }
      const tracked = listTrackedAsins(db, { domain: domain ?? DEFAULT_DOMAIN });
      const envelope = toUniversalEnvelope("tracked_asins", {
        added: asins.length,
        total_tracked: tracked.length,
        asins: tracked,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 7. Take Snapshot ---
server.tool(
  "keepa_take_snapshot",
  "Fetch and store a snapshot for tracked ASINs. Returns any detected changes vs the previous snapshot.",
  {
    asins: z.array(z.string()).optional().describe("Specific ASINs (default: all tracked)"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, domain }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      const domainStr = domain ?? DEFAULT_DOMAIN;
      const targetAsins = asins?.length
        ? asins
        : listTrackedAsins(db, { domain: domainStr }).map((t) => t.asin);

      if (!targetAsins.length) {
        const envelope = toUniversalEnvelope("snapshot_result", {
          message: "No ASINs to snapshot. Use keepa_track_asins first.",
          snapshots: 0,
          changes: [],
        });
        return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
      }

      // Batch ASINs in groups of 100
      const allChanges: unknown[] = [];
      let snapshotCount = 0;

      for (let i = 0; i < targetAsins.length; i += 100) {
        const batch = targetAsins.slice(i, i + 100);
        const res = await getProduct(client, {
          asins: batch,
          domain: domainStr,
          stats: 30,
          rating: true,
          buybox: true,
        });

        for (const raw of res.data.products ?? []) {
          const snapshot = transformProductSnapshot(raw, domainStr);
          const previous = getLatestSnapshot(db, snapshot.asin, domainStr);

          insertSnapshot(db, snapshot, JSON.stringify(raw));
          snapshotCount++;

          if (previous) {
            const changes = detectChanges(previous, snapshot);
            for (const change of changes) {
              insertChange(db, change);
              allChanges.push(change);
            }
          }
        }
      }

      const envelope = toUniversalEnvelope("snapshot_result", {
        snapshots: snapshotCount,
        changes: allChanges,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 8. Get Changes ---
server.tool(
  "keepa_get_changes",
  "Query detected changes for ASINs over a given period.",
  {
    asins: z.array(z.string()).optional().describe("Filter by ASINs"),
    days: z.number().int().optional().describe("Number of days to look back (default: 7)"),
    severity: z.enum(["critical", "warning", "info"]).optional().describe("Filter by severity"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, days, severity, domain }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      const changes = getRecentChanges(db, {
        asins: asins ?? undefined,
        domain: domain ?? DEFAULT_DOMAIN,
        days: days ?? 7,
        severity: severity ?? undefined,
      });
      const envelope = toUniversalEnvelope("changes", changes);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 9. Analyze BSR Trend ---
server.tool(
  "keepa_analyze_bsr_trend",
  "Analyze BSR trend for ASINs over a period. Flags deterioration patterns.",
  {
    asins: z.array(z.string()).min(1).describe("ASINs to analyze"),
    period_days: z.number().int().optional().describe("Analysis period in days (default: 10)"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, period_days, domain }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      const domainStr = domain ?? DEFAULT_DOMAIN;
      const trends = asins.map((asin) => {
        const snapshots = getSnapshotHistory(db!, asin, domainStr, period_days ?? 10);
        return analyzeBsrTrend(snapshots, asin, { periodDays: period_days });
      });
      const envelope = toUniversalEnvelope("bsr_trend", trends);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 10. Check Variations ---
server.tool(
  "keepa_check_variations",
  "Check variation family for orphans, attribute drift, and child changes.",
  {
    asins: z.array(z.string()).min(1).describe("ASINs to check"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, domain }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      const domainStr = domain ?? DEFAULT_DOMAIN;
      const res = await getProduct(client, {
        asins,
        domain: domainStr,
        stats: 1,
        rating: true,
      });

      const allAlerts: unknown[] = [];
      for (const raw of res.data.products ?? []) {
        const current = transformProductSnapshot(raw, domainStr);
        const previous = getLatestSnapshot(db, current.asin, domainStr);
        if (previous) {
          const alerts = checkVariationChanges(previous, current);
          allAlerts.push(...alerts);
        }
      }

      const envelope = toUniversalEnvelope("variation_alerts", allAlerts, {
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =====================
// Promo Tools (3)
// =====================

// --- 11. Add Promo ---
server.tool(
  "keepa_add_promo",
  "Register a promotional event for an ASIN (coupon, deal, Lightning Deal, etc.).",
  {
    asin: z.string().describe("ASIN the promo applies to"),
    promo_type: z.string().describe("Type of promo (coupon, lightning_deal, deal_of_day, etc.)"),
    start_date: z.string().describe("Promo start date (ISO 8601)"),
    end_date: z.string().optional().describe("Promo end date (ISO 8601)"),
    notes: z.string().optional().describe("Additional notes"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asin, promo_type, start_date, end_date, notes, domain }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      const id = insertPromo(db, {
        asin,
        domain: domain ?? DEFAULT_DOMAIN,
        promo_type,
        start_date,
        end_date: end_date ?? null,
        notes: notes ?? null,
      });
      const envelope = toUniversalEnvelope("promo_created", { id, asin, promo_type, start_date });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 12. List Promos ---
server.tool(
  "keepa_list_promos",
  "List promotional events for an ASIN or all tracked ASINs.",
  {
    asin: z.string().optional().describe("Filter by ASIN"),
    active_only: z.boolean().optional().describe("Only show active promos (default: false)"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asin, active_only, domain }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      const promos = listPromos(db, {
        asin: asin ?? undefined,
        domain: domain ?? DEFAULT_DOMAIN,
        activeOnly: active_only ?? false,
      });
      const envelope = toUniversalEnvelope("promos", promos);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 13. Analyze Promo Impact ---
server.tool(
  "keepa_analyze_promo_impact",
  "Overlay a promo with rank/price data to measure lift. Compares before, during, and after the promo period.",
  {
    promo_id: z.number().int().optional().describe("Promo ID to analyze"),
    asin: z.string().optional().describe("ASIN (if not using promo_id)"),
    start_date: z.string().optional().describe("Period start (if not using promo_id)"),
    end_date: z.string().optional().describe("Period end (if not using promo_id)"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ promo_id, asin, start_date, end_date, domain }) => {
    if (!storageAvailable || !db) return storageUnavailableResult();
    try {
      let impact;
      if (promo_id) {
        impact = analyzePromoImpact(db, { promoId: promo_id });
      } else if (asin && start_date && end_date) {
        impact = analyzePromoImpact(db, {
          asin,
          domain: domain ?? DEFAULT_DOMAIN,
          startDate: start_date,
          endDate: end_date,
        });
      } else {
        const envelope = toErrorEnvelope(
          "invalid_params",
          "Provide either promo_id or (asin + start_date + end_date)"
        );
        return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }], isError: true };
      }

      const envelope = toUniversalEnvelope("promo_impact", impact);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =====================
// New Tools (5)
// =====================

// --- 14. Get Sales History ---
server.tool(
  "keepa_get_sales_history",
  "Get monthly sales volume time series for ASINs. Shows how many units are sold per month over time.",
  {
    asins: z.array(z.string()).min(1).max(100).describe("ASINs to get sales history for"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, domain }) => {
    try {
      const res = await getProduct(client, {
        asins,
        domain: domain ?? DEFAULT_DOMAIN,
        stats: 30,
        history: true,
      });
      const histories = (res.data.products ?? []).map(transformSalesHistory);
      const envelope = toUniversalEnvelope("sales_history", histories, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 15. Get Deals ---
server.tool(
  "keepa_get_deals",
  "Get coupon history, active promotions, and lightning deal data for ASINs.",
  {
    asins: z.array(z.string()).min(1).max(100).describe("ASINs to get deal data for"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, domain }) => {
    try {
      const res = await getProduct(client, {
        asins,
        domain: domain ?? DEFAULT_DOMAIN,
        stats: 30,
        history: true,
      });
      const deals = (res.data.products ?? []).map(transformDeals);
      const envelope = toUniversalEnvelope("deals", deals, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 16. Get Seller Stats ---
server.tool(
  "keepa_get_seller_stats",
  "Get buy box statistics per seller for ASINs, including win percentage, average price, and FBA status.",
  {
    asins: z.array(z.string()).min(1).max(100).describe("ASINs to get seller stats for"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ asins, domain }) => {
    try {
      const res = await getProduct(client, {
        asins,
        domain: domain ?? DEFAULT_DOMAIN,
        stats: 30,
        offers: 20,
        buybox: true,
      });
      const stats = (res.data.products ?? []).map(transformSellerStats);
      const envelope = toUniversalEnvelope("seller_stats", stats, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 17. Get Best Sellers ---
server.tool(
  "keepa_get_best_sellers",
  "Get the best seller ASIN list for a category.",
  {
    category: z.number().int().describe("Category ID to look up"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ category, domain }) => {
    try {
      const res = await getBestSellers(client, {
        domain: domain ?? DEFAULT_DOMAIN,
        category,
      });
      const data = res.data.bestSellersList;
      const envelope = toUniversalEnvelope("best_sellers", {
        category_id: data?.categoryId ?? category,
        asin_list: data?.asinList ?? [],
        last_update: data?.lastUpdate ?? null,
      }, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 18. Get Category ---
server.tool(
  "keepa_get_category",
  "Look up category details including name, parent, children, and product count.",
  {
    category: z.number().int().describe("Category ID to look up"),
    domain: z.string().optional().describe("Amazon domain (default: com)"),
  },
  async ({ category, domain }) => {
    try {
      const res = await getCategoryLookup(client, {
        domain: domain ?? DEFAULT_DOMAIN,
        category,
      });
      const categories = res.data.categories ?? {};
      const catData = categories[String(category)] ?? null;
      const envelope = toUniversalEnvelope("category", catData ? {
        category_id: catData.catId,
        name: catData.name,
        parent: catData.parent ?? null,
        children: catData.children ?? [],
        highest_rank: catData.highestRank ?? null,
        product_count: catData.productCount ?? null,
      } : null, {
        marketplace: domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

  return server;
}

// ---------------------------------------------------------------------------
// Clerk OAuth token validation (hits Clerk /oauth/userinfo per request)
// ---------------------------------------------------------------------------
async function validateClerkToken(
  bearer: string,
  clerkIssuer: string,
): Promise<{ ok: true; email: string } | { ok: false; status: number; reason?: string }> {
  try {
    const response = await fetch(`${clerkIssuer}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = (await response.json()) as { email?: string; email_address?: string } | null;
    if (!body) return { ok: false, status: 502, reason: "userinfo_malformed" };
    return { ok: true, email: body.email || body.email_address || "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return { ok: false, status: 502, reason: `clerk_unreachable: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// HTTP transport (TRANSPORT=http) — used in Railway / Cowork deployment
// ---------------------------------------------------------------------------
async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const clerkIssuer = process.env.CLERK_OAUTH_ISSUER ?? "https://clerk.sitruna.com";
  const emailDomain = (process.env.MCP_OAUTH_EMAIL_DOMAIN ?? "sitruna.com").toLowerCase();
  const oauthEnabled = process.env.MCP_OAUTH_ENABLED === "true";

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // CORS — required for Anthropic web connectors negotiating OAuth from the browser
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
    next();
  });

  // Auth middleware — validates Clerk OAuth bearer token when MCP_OAUTH_ENABLED=true
  const authMiddleware: RequestHandler = async (req, res, next) => {
    if (!oauthEnabled) { next(); return; }
    const header = req.headers.authorization;
    const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
    const token = match ? match[1] : null;
    if (!token) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      res.set("WWW-Authenticate", `Bearer realm="mcp", resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing bearer" }, id: null });
      return;
    }
    const result = await validateClerkToken(token, clerkIssuer);
    if (!result.ok) {
      res.status(result.status === 502 ? 502 : 401).json({ jsonrpc: "2.0", error: { code: -32001, message: `Unauthorized: ${result.reason ?? "invalid_token"}` }, id: null });
      return;
    }
    const email = String(result.email).toLowerCase();
    if (!email.endsWith(`@${emailDomain}`)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32001, message: `Forbidden: ${emailDomain} email required` }, id: null });
      return;
    }
    next();
  };

  // Liveness probe — unauthenticated, used by Railway healthcheck
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "keepa-adapter", version: "1.0.0" }));
  app.get("/sse", (_req, res) => res.send("ok"));

  // OAuth 2.0 Protected Resource Metadata (RFC 9728) — required by Anthropic connector
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    res.json({
      resource: `${proto}://${host}`,
      authorization_servers: [clerkIssuer],
      scopes_supported: ["openid", "profile", "email"],
      bearer_methods_supported: ["header"],
    });
  });

  // OAuth 2.1 authorization server metadata
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: clerkIssuer,
      authorization_endpoint: `${clerkIssuer}/oauth/authorize`,
      token_endpoint: `${clerkIssuer}/oauth/token`,
      userinfo_endpoint: `${clerkIssuer}/oauth/userinfo`,
      jwks_uri: `${clerkIssuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
  });

  // Stateless MCP handler — fresh McpServer + transport per request
  const handleMcp: RequestHandler = async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };

  app.post("/mcp", authMiddleware, handleMcp);
  app.get("/mcp", authMiddleware, handleMcp);
  app.delete("/mcp", authMiddleware, handleMcp);

  app.listen(port, () => {
    console.error(`[keepa-adapter] HTTP transport listening on port ${port} (oauth=${oauthEnabled})`);
  });
}

// ---------------------------------------------------------------------------
// Stdio transport (TRANSPORT=stdio, default for local dev)
// ---------------------------------------------------------------------------
async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const transport = (process.env.TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
