/**
 * Hit the Keepa API and save raw responses for schema modeling.
 * Usage: KEEPA_API_KEY=xxx npm run discover
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const API_KEY = process.env.KEEPA_API_KEY;
if (!API_KEY) {
  console.error("Set KEEPA_API_KEY to run discovery");
  process.exit(1);
}

const ASIN = process.argv[2] ?? "B0012ZQPKG";
const OUT_DIR = join(import.meta.dirname ?? ".", "..", "tests", "fixtures", "raw");

async function discover() {
  mkdirSync(OUT_DIR, { recursive: true });

  // 1. Product endpoint
  console.log(`Fetching product data for ASIN ${ASIN}...`);
  const productUrl = `https://api.keepa.com/product?key=${API_KEY}&domain=1&asin=${ASIN}&stats=30&offers=20&rating=1`;
  const productRes = await fetch(productUrl);
  const productJson = await productRes.json();
  writeFileSync(
    join(OUT_DIR, "product-response.json"),
    JSON.stringify(productJson, null, 2)
  );
  console.log(`  Saved product-response.json (tokens left: ${productJson.tokensLeft})`);

  // 2. Token status
  console.log("Fetching token status...");
  const tokenUrl = `https://api.keepa.com/token?key=${API_KEY}`;
  const tokenRes = await fetch(tokenUrl);
  const tokenJson = await tokenRes.json();
  writeFileSync(
    join(OUT_DIR, "token-response.json"),
    JSON.stringify(tokenJson, null, 2)
  );
  console.log(`  Saved token-response.json`);

  console.log("Discovery complete.");
}

discover().catch((err) => {
  console.error("Discovery failed:", err);
  process.exit(1);
});
