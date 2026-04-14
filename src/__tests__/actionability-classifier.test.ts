/**
 * Tests for src/prompts/actionability-classifier.ts
 *
 * Covers:
 *  - ACTIONABILITY_SYSTEM_PROMPT static content
 *  - buildActionabilityPrompt: title/body inclusion, body truncation, null/empty body
 *  - ActionabilityResult shape (compile-time)
 */

import { describe, it, expect } from "vitest";
import {
  ACTIONABILITY_SYSTEM_PROMPT,
  buildActionabilityPrompt,
  type ActionabilityResult,
} from "../prompts/actionability-classifier.js";

// ---------------------------------------------------------------------------
// Compile-time shape check: ActionabilityResult
// ---------------------------------------------------------------------------

// This function only exists to assert that ActionabilityResult has the right
// shape at the TypeScript level — it is never called at runtime.
function _assertShape(r: ActionabilityResult): void {
  const _a: boolean = r.actionable;
  const _b: string = r.reason;
  void _a;
  void _b;
}
void _assertShape;

// ---------------------------------------------------------------------------
// ACTIONABILITY_SYSTEM_PROMPT — static content
// ---------------------------------------------------------------------------

describe("ACTIONABILITY_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof ACTIONABILITY_SYSTEM_PROMPT).toBe("string");
    expect(ACTIONABILITY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("lists meta: as a non-actionable title prefix", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT.toLowerCase()).toContain("meta:");
  });

  it("lists tracker: as a non-actionable title prefix", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT.toLowerCase()).toContain("tracker:");
  });

  it("lists epic: as a non-actionable title prefix", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT.toLowerCase()).toContain("epic:");
  });

  it("lists roadmap: as a non-actionable title prefix", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT.toLowerCase()).toContain("roadmap:");
  });

  it("mentions the case-insensitive qualifier", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT).toContain("case-insensitive");
  });

  it("specifies the exact JSON shape to return", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT).toContain('"actionable"');
    expect(ACTIONABILITY_SYSTEM_PROMPT).toContain('"reason"');
  });

  it("instructs agent to return only JSON (no markdown fencing)", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT).toContain("ONLY");
  });

  it("describes what makes an issue actionable", () => {
    expect(ACTIONABILITY_SYSTEM_PROMPT).toContain("actionable");
    // Should mention concrete coding tasks
    expect(ACTIONABILITY_SYSTEM_PROMPT).toMatch(/bug fix|feature request|code change|technical task/i);
  });
});

// ---------------------------------------------------------------------------
// buildActionabilityPrompt — basic inclusion
// ---------------------------------------------------------------------------

describe("buildActionabilityPrompt — title and body inclusion", () => {
  const TITLE = "Fix null pointer in auth middleware";
  const BODY = "When a request arrives without a Bearer token the middleware crashes.";

  it("includes the issue title", () => {
    const prompt = buildActionabilityPrompt(TITLE, BODY);
    expect(prompt).toContain(TITLE);
  });

  it("includes the issue body", () => {
    const prompt = buildActionabilityPrompt(TITLE, BODY);
    expect(prompt).toContain(BODY);
  });

  it("asks the model to return JSON", () => {
    const prompt = buildActionabilityPrompt(TITLE, BODY);
    expect(prompt.toLowerCase()).toContain("json");
  });

  it("returns a non-empty string", () => {
    const prompt = buildActionabilityPrompt(TITLE, BODY);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildActionabilityPrompt — body truncation
// ---------------------------------------------------------------------------

describe("buildActionabilityPrompt — body truncation at 1000 characters", () => {
  const TITLE = "Long body issue";

  it("includes the full body when it is exactly 1000 characters", () => {
    const body = "a".repeat(1000);
    const prompt = buildActionabilityPrompt(TITLE, body);
    expect(prompt).toContain(body);
  });

  it("includes only the first 1000 characters when body exceeds 1000 chars", () => {
    const firstPart = "x".repeat(1000);
    const overflow = "OVERFLOW_SENTINEL";
    const longBody = firstPart + overflow;
    const prompt = buildActionabilityPrompt(TITLE, longBody);
    expect(prompt).toContain(firstPart);
    expect(prompt).not.toContain(overflow);
  });

  it("does not truncate bodies shorter than 1000 characters", () => {
    const body = "Short body text.";
    const prompt = buildActionabilityPrompt(TITLE, body);
    expect(prompt).toContain(body);
  });
});

// ---------------------------------------------------------------------------
// buildActionabilityPrompt — null / empty body handling
// ---------------------------------------------------------------------------

describe("buildActionabilityPrompt — empty body", () => {
  it("handles an empty string body without throwing", () => {
    expect(() => buildActionabilityPrompt("Some title", "")).not.toThrow();
  });

  it("still includes the title when body is empty", () => {
    const prompt = buildActionabilityPrompt("Some title", "");
    expect(prompt).toContain("Some title");
  });

  it("still asks for JSON evaluation when body is empty", () => {
    const prompt = buildActionabilityPrompt("Some title", "");
    expect(prompt.toLowerCase()).toContain("json");
  });
});
