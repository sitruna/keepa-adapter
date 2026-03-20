import { ZodSchema } from "zod";
import { BASE_URL, DEFAULT_TIMEOUT_MS } from "../constants.js";
import { KeepaTokenBucket } from "../utils/rate-limit.js";

export interface TokenMeta {
  consumed?: number;
  remaining: number;
  refill_in_ms: number;
  refill_rate: number;
}

export interface KeepaResponse<T> {
  data: T;
  tokens: TokenMeta;
}

export class KeepaApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "KeepaApiError";
  }
}

export class KeepaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  readonly bucket: KeepaTokenBucket;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    timeoutMs?: number;
    bucket?: KeepaTokenBucket;
  }) {
    this.apiKey =
      opts?.apiKey ?? process.env.KEEPA_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error(
        "KEEPA_API_KEY is required. Set it as an environment variable or pass it to the constructor."
      );
    }
    this.baseUrl = opts?.baseUrl ?? BASE_URL;
    this.timeoutMs =
      opts?.timeoutMs ??
      (Number(process.env.KEEPA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    this.bucket = opts?.bucket ?? new KeepaTokenBucket();
  }

  async get<T>(
    path: string,
    schema: ZodSchema<T>,
    params?: Record<string, string | number | boolean | undefined>,
    tokenCost = 1
  ): Promise<KeepaResponse<T>> {
    await this.bucket.acquire(tokenCost);

    const url = new URL(path, this.baseUrl);
    // Keepa uses query param for auth
    url.searchParams.set("key", this.apiKey);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => undefined);
        throw new KeepaApiError(
          `Keepa API ${res.status}: ${res.statusText}`,
          res.status,
          body
        );
      }

      const json = await res.json();
      const parsed = schema.parse(json);

      // Extract token metadata from response
      const tokenMeta: TokenMeta = {
        remaining: (json as Record<string, number>).tokensLeft ?? 0,
        refill_in_ms: (json as Record<string, number>).refillIn ?? 0,
        refill_rate: (json as Record<string, number>).refillRate ?? 0,
      };

      // Feed token info back to rate limiter
      this.bucket.updateFromResponse({
        tokensLeft: tokenMeta.remaining,
        refillIn: tokenMeta.refill_in_ms,
        refillRate: tokenMeta.refill_rate,
      });

      return { data: parsed, tokens: tokenMeta };
    } catch (err) {
      if (err instanceof KeepaApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new KeepaApiError(
          `Keepa API request timed out after ${this.timeoutMs}ms`,
          408
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
