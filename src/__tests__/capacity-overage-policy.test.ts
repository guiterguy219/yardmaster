/**
 * Tests for the overage-policy logic added to checkCapacity().
 *
 * Covers every policy value ("defer-low", "defer-normal", "block-all", "allow")
 * and their interaction with each priority level and with P0's unconditional
 * bypass.  Also covers the behaviour when no policy / no priority is supplied
 * (defaults) and the canProceed/isUsingOverage/reason fields in the response.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — must be hoisted before any module that transitively uses getDb
// ---------------------------------------------------------------------------

vi.mock("../db.js", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  db.exec(`
    CREATE TABLE IF NOT EXISTS capacity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resets_at INTEGER,
      rate_limit_type TEXT,
      is_using_overage INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      success INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return { getDb: () => db };
});

import { checkCapacity, recordCapacityEvent } from "../capacity.js";
import { PRIORITY } from "../queue/constants.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedOverageEvent(resetsAt: number | null = null): void {
  recordCapacityEvent({ resetsAt, rateLimitType: null, isUsingOverage: true });
}

function seedNonOverageEvent(): void {
  recordCapacityEvent({ resetsAt: null, rateLimitType: null, isUsingOverage: false });
}

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM capacity_events").run();
  db.prepare("DELETE FROM task_logs").run();
});

// ---------------------------------------------------------------------------
// policy: "defer-low" (default)
// ---------------------------------------------------------------------------

describe('checkCapacity — policy: "defer-low"', () => {
  it("allows P0 (IMMEDIATE) — P0 always bypasses", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.IMMEDIATE, "defer-low");
    expect(status.canProceed).toBe(true);
    expect(status.isUsingOverage).toBe(true);
  });

  it("allows URGENT (P1) — below the LOW threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.URGENT, "defer-low");
    expect(status.canProceed).toBe(true);
  });

  it("allows HIGH (P2) — below the LOW threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.HIGH, "defer-low");
    expect(status.canProceed).toBe(true);
  });

  it("allows NORMAL (P3) — below the LOW threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.NORMAL, "defer-low");
    expect(status.canProceed).toBe(true);
  });

  it("blocks LOW (P4) — at the LOW threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.LOW, "defer-low");
    expect(status.canProceed).toBe(false);
    expect(status.isUsingOverage).toBe(true);
    expect(status.reason).toBe("overage-deferred");
  });

  it("blocks LOW (P4) when no policy supplied (default is defer-low)", () => {
    seedOverageEvent();
    // Omit overagePolicy entirely — should default to "defer-low"
    const status = checkCapacity(PRIORITY.LOW);
    expect(status.canProceed).toBe(false);
    expect(status.reason).toBe("overage-deferred");
  });

  it("allows undefined priority (coerced to NORMAL) — below LOW threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(undefined, "defer-low");
    expect(status.canProceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// policy: "defer-normal"
// ---------------------------------------------------------------------------

describe('checkCapacity — policy: "defer-normal"', () => {
  it("allows P0 (IMMEDIATE)", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.IMMEDIATE, "defer-normal");
    expect(status.canProceed).toBe(true);
  });

  it("allows URGENT (P1) — below NORMAL threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.URGENT, "defer-normal");
    expect(status.canProceed).toBe(true);
  });

  it("allows HIGH (P2) — below NORMAL threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.HIGH, "defer-normal");
    expect(status.canProceed).toBe(true);
  });

  it("blocks NORMAL (P3) — at the NORMAL threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.NORMAL, "defer-normal");
    expect(status.canProceed).toBe(false);
    expect(status.reason).toBe("overage-deferred");
  });

  it("blocks LOW (P4) — above NORMAL threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.LOW, "defer-normal");
    expect(status.canProceed).toBe(false);
    expect(status.reason).toBe("overage-deferred");
  });

  it("blocks undefined priority (coerced to NORMAL) — at NORMAL threshold", () => {
    seedOverageEvent();
    const status = checkCapacity(undefined, "defer-normal");
    expect(status.canProceed).toBe(false);
    expect(status.reason).toBe("overage-deferred");
  });
});

// ---------------------------------------------------------------------------
// policy: "block-all"
// ---------------------------------------------------------------------------

describe('checkCapacity — policy: "block-all"', () => {
  it("allows P0 (IMMEDIATE) — P0 always bypasses", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.IMMEDIATE, "block-all");
    expect(status.canProceed).toBe(true);
  });

  it("blocks URGENT (P1)", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.URGENT, "block-all");
    expect(status.canProceed).toBe(false);
    expect(status.reason).toBe("overage-deferred");
  });

  it("blocks HIGH (P2)", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.HIGH, "block-all");
    expect(status.canProceed).toBe(false);
  });

  it("blocks NORMAL (P3)", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.NORMAL, "block-all");
    expect(status.canProceed).toBe(false);
  });

  it("blocks LOW (P4)", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.LOW, "block-all");
    expect(status.canProceed).toBe(false);
  });

  it("blocks undefined priority (coerced to NORMAL)", () => {
    seedOverageEvent();
    const status = checkCapacity(undefined, "block-all");
    expect(status.canProceed).toBe(false);
    expect(status.reason).toBe("overage-deferred");
  });
});

// ---------------------------------------------------------------------------
// policy: "allow"
// ---------------------------------------------------------------------------

describe('checkCapacity — policy: "allow"', () => {
  it("allows P0 (IMMEDIATE)", () => {
    seedOverageEvent();
    expect(checkCapacity(PRIORITY.IMMEDIATE, "allow").canProceed).toBe(true);
  });

  it("allows URGENT (P1)", () => {
    seedOverageEvent();
    expect(checkCapacity(PRIORITY.URGENT, "allow").canProceed).toBe(true);
  });

  it("allows HIGH (P2)", () => {
    seedOverageEvent();
    expect(checkCapacity(PRIORITY.HIGH, "allow").canProceed).toBe(true);
  });

  it("allows NORMAL (P3)", () => {
    seedOverageEvent();
    expect(checkCapacity(PRIORITY.NORMAL, "allow").canProceed).toBe(true);
  });

  it("allows LOW (P4) — policy never blocks", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.LOW, "allow");
    expect(status.canProceed).toBe(true);
    expect(status.isUsingOverage).toBe(true);
  });

  it("allows undefined priority", () => {
    seedOverageEvent();
    expect(checkCapacity(undefined, "allow").canProceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Metadata / response shape
// ---------------------------------------------------------------------------

describe("checkCapacity — overage metadata", () => {
  it("sets isUsingOverage: true in blocked response", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.LOW, "defer-low");
    expect(status.isUsingOverage).toBe(true);
  });

  it("sets isUsingOverage: true in allowed-by-policy response", () => {
    seedOverageEvent();
    const status = checkCapacity(PRIORITY.NORMAL, "allow");
    expect(status.isUsingOverage).toBe(true);
  });

  it("populates resetsAt from the capacity event when a reset time is present", () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    seedOverageEvent(futureEpoch);
    const status = checkCapacity(PRIORITY.LOW, "block-all");
    expect(status.resetsAt).toBeInstanceOf(Date);
    // Allow ±1 second for integer-second precision
    expect(Math.abs(status.resetsAt!.getTime() - futureEpoch * 1000)).toBeLessThan(1001);
  });

  it("sets resetsAt to null when no reset time was recorded", () => {
    seedOverageEvent(null);
    const status = checkCapacity(PRIORITY.LOW, "block-all");
    expect(status.resetsAt).toBeNull();
  });

  it("policy has no effect when the latest event is NOT using overage", () => {
    seedNonOverageEvent();
    // Even the most restrictive policy must not block a non-overage situation
    const status = checkCapacity(PRIORITY.LOW, "block-all");
    expect(status.canProceed).toBe(true);
    expect(status.isUsingOverage).toBe(false);
  });

  it("no-capacity-events path is unaffected by policy arguments", () => {
    // Table is empty — checkCapacity short-circuits before policy evaluation
    const status = checkCapacity(PRIORITY.LOW, "block-all");
    expect(status.canProceed).toBe(true);
    expect(status.isUsingOverage).toBe(false);
  });
});
