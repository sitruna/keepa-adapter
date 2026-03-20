/**
 * Token bucket adapted for Keepa's per-minute token system.
 * Updates balance from API response headers (tokensLeft, refillIn, refillRate).
 */
export class KeepaTokenBucket {
  private tokens: number;
  private refillRate: number; // tokens per ms
  private lastRefill: number;
  private maxTokens: number;

  constructor(tokensPerMinute?: number) {
    const tpm =
      tokensPerMinute ??
      (Number(process.env.KEEPA_TOKENS_PER_MINUTE) || 5);
    this.maxTokens = tpm;
    this.tokens = tpm;
    this.refillRate = tpm / 60_000; // tokens per ms
    this.lastRefill = Date.now();
  }

  /** Update internal state from Keepa API response metadata */
  updateFromResponse(meta: {
    tokensLeft: number;
    refillIn: number;
    refillRate: number;
  }): void {
    this.tokens = meta.tokensLeft;
    this.refillRate = meta.refillRate / 60_000;
    this.maxTokens = Math.max(this.maxTokens, meta.refillRate, meta.tokensLeft);
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefill = now;
  }

  /** Acquire `cost` tokens, waiting if necessary */
  async acquire(cost = 1): Promise<void> {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return;
    }
    const waitMs = Math.ceil((cost - this.tokens) / this.refillRate);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= cost;
  }

  /** Current token balance (for inspection/logging) */
  get balance(): number {
    this.refill();
    return this.tokens;
  }
}
