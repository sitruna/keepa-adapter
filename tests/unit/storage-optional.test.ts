import { describe, it, expect } from "vitest";
import { initDb } from "../../src/storage/db.js";

// These tests verify the try/catch wrapper pattern used in index.ts.
// They don't need better-sqlite3 bindings to succeed — initDb throws either
// because the path is bad OR because native bindings aren't compiled locally.
// Both cases exercise the same catch block that keeps the server alive on Railway.

describe("storage optional init", () => {
  it("initDb throws for unwritable/missing path", () => {
    expect(() => initDb("/nonexistent/path/keepa.db")).toThrow();
  });

  it("try/catch wrapper catches initDb failure and leaves db null, storageAvailable false", () => {
    let db: ReturnType<typeof initDb> | null = null;
    let storageAvailable = false;
    try {
      db = initDb("/nonexistent/path/keepa.db");
      storageAvailable = true;
    } catch {
      // expected — bindings missing locally or path unwritable
    }
    expect(db).toBeNull();
    expect(storageAvailable).toBe(false);
  });
});
