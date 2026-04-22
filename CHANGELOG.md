# Changelog

## Unreleased

### Fixed
- **FBM-only listings now surface pricing and offer counts.** `keepa_get_product` and `keepa_get_product_slim` previously returned `-2` for `offer_count_fba`/`offer_count_fbm` and `null` across price fields for FBM-only listings (reproduced on `B07KS958KC` on amazon.co.uk). Root cause: Keepa uses `-1` ("no data") and `-2` ("OOS / no offer / not collected") as sentinels, but the adapter only normalised `-1` — so `-2` leaked through on offer counts and produced `-0.02` on price CSVs. Fixes:
  - Both sentinels are now treated as `null` in `getLatestCsvValue`, `decodeCsvTimeSeries`, `offer_count_fba`, `offer_count_fbm`, `out_of_stock_percentage_*`, and subcategory ranks.
  - `new_price` now falls back to `csv[NEW_FBM_SHIPPING]` and then `csv[NEW_FBA]` when `csv[NEW]` is empty, so FBM-only listings surface a price.
  - `buy_box_price` falls back through the same FBM chain when `csv[BUY_BOX_SHIPPING]` is empty.

## 1.2.0 — 2026-04-22

### Added
- **`keepa_get_product_slim` tool.** Field-projected variant of `keepa_get_product`. Default projection returns the 10 fields most skills actually use (asin, title, brand, new_price, sales_rank, rating, review_count, monthly_sold, offer_count_fba, offer_count_fbm) — drops description/features/subcategory_ranks/images/variations by default. Measured ~85% smaller than `keepa_get_product` on a 25-ASIN batch (Henryka UK): the default call blows the MCP response-token limit (~75 KB for 25 ASINs) while the slim variant stays comfortably inside (~10 KB). Pass explicit `fields` to override the projection; unknown names are silently dropped.
- **Response envelope `data_type` is `product_snapshot_slim`** (vs `product_snapshot` for the full tool) so downstream skills can tell them apart.

### Changed
- **`keepa_get_product` description** updated to recommend `keepa_get_product_slim` when skills only need top-level metrics.

## 1.1.0 — 2026-04-13

### Fixed
- **Buy box data now populated correctly.** Added `buybox=1` parameter to Keepa API calls for `keepa_get_product`, `keepa_get_buy_box`, `keepa_get_seller_stats`, and `keepa_take_snapshot`. Previously these fields (`buy_box_seller_id`, `buy_box_price`, `out_of_stock_percentage`, `buyBoxStats`) were silently returned as null because the buy box module was never requested.

### Added
- **Configurable default marketplace.** Set `KEEPA_DEFAULT_DOMAIN` in your `.env` (e.g. `uk`, `de`, `jp`) so international users don't need to pass `domain` on every tool call. Defaults to `com` if unset.

### Token usage note
- The buy box fix increases token cost slightly for the four affected tools, as Keepa charges extra tokens for the buy box module (~2 additional tokens per ASIN). Normal usage should not be significantly impacted.
