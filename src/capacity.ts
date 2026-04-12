import { getDb } from "./db.js";
import type { OveragePolicy } from "./config.js";
import { PRIORITY, type PriorityLevel } from "./queue/constants.js";

export interface CapacityEvent {
  resetsAt: number | null;
  rateLimitType: string | null;
  isUsingOverage: boolean;
}

export interface CapacityStatus {
  canProceed: boolean;
  isUsingOverage: boolean;
  resetsAt: Date | null;
  reason?: string;
}

export function recordCapacityEvent(event: CapacityEvent): void {
  getDb()
    .prepare(
      `INSERT INTO capacity_events (resets_at, rate_limit_type, is_using_overage)
       VALUES (?, ?, ?)`
    )
    .run(event.resetsAt, event.rateLimitType, event.isUsingOverage ? 1 : 0);
}

export function checkCapacity(priority?: PriorityLevel, overagePolicy?: OveragePolicy): CapacityStatus {
  const db = getDb();

  // Get the most recent capacity event
  const latest = db
    .prepare(
      "SELECT * FROM capacity_events ORDER BY recorded_at DESC LIMIT 1"
    )
    .get() as {
      resets_at: number | null;
      rate_limit_type: string | null;
      is_using_overage: number;
      recorded_at: string;
    } | undefined;

  if (!latest) {
    // No capacity data yet — proceed optimistically
    return { canProceed: true, isUsingOverage: false, resetsAt: null };
  }

  const isUsingOverage = latest.is_using_overage === 1;
  const resetsAt = latest.resets_at ? new Date(latest.resets_at * 1000) : null;

  // Count consecutive failures (throttle detection)
  const recentFailures = db
    .prepare(
      `SELECT COUNT(*) as count FROM task_logs
       WHERE success = 0
       AND created_at > datetime('now', '-30 minutes')
       ORDER BY created_at DESC`
    )
    .get() as { count: number };

  // 3+ consecutive failures in 30 minutes = likely throttled
  if (recentFailures.count >= 3) {
    return {
      canProceed: false,
      isUsingOverage,
      resetsAt,
      reason: `${recentFailures.count} consecutive failures in last 30 minutes — likely rate-limited. Resets at: ${resetsAt?.toISOString() ?? "unknown"}`,
    };
  }

  // If using overage, apply policy (P0 always passes regardless of policy)
  if (isUsingOverage) {
    const policy: OveragePolicy = overagePolicy ?? "defer-low";
    const isP0 = priority === PRIORITY.IMMEDIATE;
    // Default undefined priority to NORMAL so deferral policies still apply
    const effectivePriority: PriorityLevel = priority ?? PRIORITY.NORMAL;

    let block = false;
    if (!isP0) {
      if (policy === "block-all") {
        block = true;
      } else if (policy === "defer-normal") {
        block = effectivePriority >= PRIORITY.NORMAL;
      } else if (policy === "defer-low") {
        block = effectivePriority >= PRIORITY.LOW;
      }
      // "allow" → never blocks
    }

    if (block) {
      return {
        canProceed: false,
        isUsingOverage: true,
        resetsAt,
        reason: "overage-deferred",
      };
    }

    return {
      canProceed: true,
      isUsingOverage: true,
      resetsAt,
      reason: "Using overage capacity",
    };
  }

  return { canProceed: true, isUsingOverage: false, resetsAt };
}
