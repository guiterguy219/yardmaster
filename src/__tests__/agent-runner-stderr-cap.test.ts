/**
 * Tests for the stderr cap trimming added to src/agent-runner.ts.
 *
 * agent-runner.ts spawns child processes and cannot be imported directly in
 * unit tests, so the cap logic is extracted here as an inline equivalent of
 * the exact expression used in the module:
 *
 *   child.stderr!.on("data", (chunk: Buffer) => {
 *     stderr += chunk.toString();
 *     if (stderr.length > STDERR_CAP * 2) {
 *       stderr = stderr.slice(-STDERR_CAP);
 *     }
 *   });
 *
 * This prevents unbounded memory growth on long-lived agent invocations that
 * emit large volumes of diagnostic output (tracked in guiterguy219/yardmaster#83).
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Helper — inline equivalent of the stderr accumulation logic in agent-runner
// ---------------------------------------------------------------------------

const STDERR_CAP = 64 * 1024; // mirrors the constant in agent-runner.ts

/**
 * Mirrors the stderr data handler body:
 *   stderr += chunk.toString();
 *   if (stderr.length > STDERR_CAP * 2) {
 *     stderr = stderr.slice(-STDERR_CAP);
 *   }
 */
function applyStderrCap(current: string, chunk: string, cap: number = STDERR_CAP): string {
  const next = current + chunk;
  if (next.length > cap * 2) {
    return next.slice(-cap);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyStderrCap", () => {
  it("accumulates small chunks without trimming", () => {
    const result = applyStderrCap("hello ", "world", STDERR_CAP);
    expect(result).toBe("hello world");
  });

  it("does not trim when total length equals 2× cap exactly", () => {
    const cap = 10;
    const current = "a".repeat(10);
    const chunk = "b".repeat(10);
    // total = 20 = 2 * cap  → condition is >, not >= → no trim
    const result = applyStderrCap(current, chunk, cap);
    expect(result).toBe("a".repeat(10) + "b".repeat(10));
    expect(result.length).toBe(20);
  });

  it("trims when total length is just over 2× cap (2*cap + 1)", () => {
    const cap = 10;
    const current = "a".repeat(10);
    const chunk = "b".repeat(11); // total = 21 > 20
    const result = applyStderrCap(current, chunk, cap);
    // slice(-cap) keeps the last `cap` bytes = "bbbbbbbbbbb".slice(-10) = "bbbbbbbbbb"
    expect(result.length).toBe(cap);
    expect(result).toBe("b".repeat(cap));
  });

  it("keeps the tail (most recent output) when trimming", () => {
    const cap = 8;
    // Build up a string that clearly identifies which end is kept
    const current = "OLD_DATA_".repeat(10); // 90 chars >> 2*cap
    const chunk = "NEW_TAIL!";             // 9 chars
    const combined = current + chunk;       // 99 chars >> 2*8=16

    const result = applyStderrCap(current, chunk, cap);

    // Tail of combined is the last `cap` characters
    expect(result).toBe(combined.slice(-cap));
    expect(result.endsWith("NEW_TAIL!".slice(-cap))).toBe(true);
  });

  it("returns exactly cap bytes after trimming large input", () => {
    const cap = 64 * 1024;
    const current = "x".repeat(cap * 2);   // already at the threshold
    const chunk = "y".repeat(1);           // push it 1 byte over
    const result = applyStderrCap(current, chunk, cap);
    expect(result.length).toBe(cap);
  });

  it("produces an empty string when current and chunk are both empty", () => {
    expect(applyStderrCap("", "", STDERR_CAP)).toBe("");
  });

  it("accumulates chunk onto an empty current string without trimming", () => {
    const chunk = "some diagnostic output";
    expect(applyStderrCap("", chunk, STDERR_CAP)).toBe(chunk);
  });

  it("preserves content when total is well below the cap threshold", () => {
    const current = "line1\nline2\n";
    const chunk = "line3\n";
    const result = applyStderrCap(current, chunk, STDERR_CAP);
    expect(result).toBe("line1\nline2\nline3\n");
  });

  it("applies cap correctly with cap=1 (edge case: cap of 1 byte)", () => {
    const cap = 1;
    // total > 2 → trim to last 1 char
    const result = applyStderrCap("ab", "c", cap); // "abc".length=3 > 2
    expect(result).toBe("c");
  });

  it("does not trim when chunk alone exceeds cap but total is within 2×cap", () => {
    const cap = 20;
    // current is empty, chunk is 35 chars — total=35 > 2*20=40? No, 35 < 40 → no trim
    const chunk = "a".repeat(35);
    const result = applyStderrCap("", chunk, cap);
    expect(result).toBe(chunk);
    expect(result.length).toBe(35);
  });
});
