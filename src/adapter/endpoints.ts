import { KeepaClient } from "./client.js";
import {
  KeepaProductResponseSchema,
  KeepaTokenStatusSchema,
  KeepaBestSellersResponseSchema,
  KeepaCategoryResponseSchema,
} from "../schema/keepa.js";
import { KEEPA_DOMAINS, DEFAULT_DOMAIN } from "../constants.js";

function domainCode(domain?: string): number {
  return KEEPA_DOMAINS[domain ?? DEFAULT_DOMAIN] ?? 1;
}

export async function getProduct(
  client: KeepaClient,
  opts: {
    asins: string[];
    domain?: string;
    stats?: number;
    history?: boolean;
    offers?: number;
    rating?: boolean;
  }
) {
  const params: Record<string, string | number | boolean | undefined> = {
    domain: domainCode(opts.domain),
    asin: opts.asins.join(","),
  };
  if (opts.stats != null) params.stats = opts.stats;
  if (opts.history === false) params.history = 0;
  if (opts.offers != null) params.offers = opts.offers;
  if (opts.rating) params.rating = 1;

  return client.get("/product", KeepaProductResponseSchema, params);
}

export async function getTokenStatus(client: KeepaClient) {
  return client.get("/token", KeepaTokenStatusSchema, undefined, 0);
}

export async function getBestSellers(
  client: KeepaClient,
  opts: { domain?: string; category: number }
) {
  return client.get("/bestsellers", KeepaBestSellersResponseSchema, {
    domain: domainCode(opts.domain),
    category: opts.category,
  });
}

export async function getCategoryLookup(
  client: KeepaClient,
  opts: { domain?: string; category: number }
) {
  return client.get("/category", KeepaCategoryResponseSchema, {
    domain: domainCode(opts.domain),
    category: opts.category,
  });
}
