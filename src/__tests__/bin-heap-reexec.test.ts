/**
 * Tests for the heap re-exec logic added to bin/ym.js.
 *
 * bin/ym.js is a side-effectful entry-point script (spawns child processes,
 * dynamically imports tsx) so it cannot be imported directly.  Instead we
 * test the two pure logic fragments in isolation:
 *
 *  1. buildNodeOptions — merges existing NODE_OPTIONS with the new heap flags
 *  2. handleChildExit  — forwards exit code or re-raises signal
 *
 * These are extracted as inline equivalents of the exact expressions used in
 * the script so that the tests remain coupled to the real behaviour.
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers — inline equivalents of the bin/ym.js expressions under test
// ---------------------------------------------------------------------------

const HEAP_FLAGS = "--max-old-space-size=4096 --heapsnapshot-near-heap-limit=3";

/**
 * Mirrors:
 *   const existing = (process.env.NODE_OPTIONS ?? "").trim();
 *   const nodeOptions = [existing, "--max-old-space-size=4096", "--heapsnapshot-near-heap-limit=3"]
 *     .filter(Boolean).join(" ");
 */
function buildNodeOptions(existingEnv: string | undefined): string {
  const existing = (existingEnv ?? "").trim();
  return [existing, "--max-old-space-size=4096", "--heapsnapshot-near-heap-limit=3"]
    .filter(Boolean)
    .join(" ");
}

/**
 * Mirrors:
 *   child.on("exit", (code, signal) => {
 *     if (signal) process.kill(process.pid, signal);
 *     else process.exit(code ?? 0);
 *   });
 */
function handleChildExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  kill: (pid: number, sig: string) => void,
  exit: (code: number) => void,
  pid: number,
): void {
  if (signal) kill(pid, signal);
  else exit(code ?? 0);
}

// ---------------------------------------------------------------------------
// 1. buildNodeOptions
// ---------------------------------------------------------------------------

describe("buildNodeOptions", () => {
  it("returns only the heap flags when NODE_OPTIONS is undefined", () => {
    expect(buildNodeOptions(undefined)).toBe(HEAP_FLAGS);
  });

  it("returns only the heap flags when NODE_OPTIONS is an empty string", () => {
    expect(buildNodeOptions("")).toBe(HEAP_FLAGS);
  });

  it("returns only the heap flags when NODE_OPTIONS is whitespace-only", () => {
    expect(buildNodeOptions("   ")).toBe(HEAP_FLAGS);
  });

  it("appends the heap flags to an existing NODE_OPTIONS value", () => {
    expect(buildNodeOptions("--experimental-vm-modules")).toBe(
      `--experimental-vm-modules ${HEAP_FLAGS}`,
    );
  });

  it("trims leading/trailing whitespace before joining", () => {
    expect(buildNodeOptions("  --experimental-vm-modules  ")).toBe(
      `--experimental-vm-modules ${HEAP_FLAGS}`,
    );
  });

  it("preserves multiple existing flags separated by spaces", () => {
    expect(buildNodeOptions("--flag-a --flag-b")).toBe(
      `--flag-a --flag-b ${HEAP_FLAGS}`,
    );
  });

  it("always ends with the heapsnapshot flag", () => {
    const result = buildNodeOptions("--something-else");
    expect(result).toMatch(/--heapsnapshot-near-heap-limit=3$/);
  });

  it("includes the max-old-space-size flag", () => {
    expect(buildNodeOptions("--something-else")).toContain("--max-old-space-size=4096");
  });

  it("never produces leading or trailing spaces", () => {
    expect(buildNodeOptions(undefined).trim()).toBe(buildNodeOptions(undefined));
    expect(buildNodeOptions("--foo").trim()).toBe(buildNodeOptions("--foo"));
  });
});

// ---------------------------------------------------------------------------
// 2. handleChildExit
// ---------------------------------------------------------------------------

describe("handleChildExit", () => {
  it("calls exit(0) when code is 0 and signal is null", () => {
    const kill = vi.fn();
    const exit = vi.fn();
    handleChildExit(0, null, kill, exit, 1234);
    expect(exit).toHaveBeenCalledWith(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("calls exit(1) when code is 1 and signal is null", () => {
    const kill = vi.fn();
    const exit = vi.fn();
    handleChildExit(1, null, kill, exit, 1234);
    expect(exit).toHaveBeenCalledWith(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("calls exit(0) when both code and signal are null (code ?? 0 path)", () => {
    const kill = vi.fn();
    const exit = vi.fn();
    handleChildExit(null, null, kill, exit, 1234);
    expect(exit).toHaveBeenCalledWith(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("re-raises SIGTERM via kill and does not call exit", () => {
    const kill = vi.fn();
    const exit = vi.fn();
    handleChildExit(null, "SIGTERM", kill, exit, 5678);
    expect(kill).toHaveBeenCalledWith(5678, "SIGTERM");
    expect(exit).not.toHaveBeenCalled();
  });

  it("re-raises SIGINT via kill and does not call exit", () => {
    const kill = vi.fn();
    const exit = vi.fn();
    handleChildExit(null, "SIGINT", kill, exit, 9999);
    expect(kill).toHaveBeenCalledWith(9999, "SIGINT");
    expect(exit).not.toHaveBeenCalled();
  });

  it("passes the correct pid to kill", () => {
    const kill = vi.fn();
    const exit = vi.fn();
    const pid = 42;
    handleChildExit(null, "SIGUSR1", kill, exit, pid);
    expect(kill).toHaveBeenCalledWith(pid, "SIGUSR1");
  });

  it("prefers signal over code when signal is truthy (signal takes priority)", () => {
    // In practice the child_process 'exit' event always has one or the other,
    // but verify the conditional: `if (signal)` runs first.
    const kill = vi.fn();
    const exit = vi.fn();
    // Artificially pass both — signal branch must win.
    handleChildExit(1 as number | null, "SIGTERM" as NodeJS.Signals | null, kill, exit, 1);
    expect(kill).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
