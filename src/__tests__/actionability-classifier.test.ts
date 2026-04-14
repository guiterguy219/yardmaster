/**
 * Tests for:
 *  - src/prompts/actionability-classifier.ts  (buildActionabilityPrompt, ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT)
 *  - src/agents/actionability-classifier.ts   (classifyActionability)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively use these modules
// ---------------------------------------------------------------------------

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runAgent } from "../agent-runner.js";
import {
  buildActionabilityPrompt,
  ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT,
} from "../prompts/actionability-classifier.js";
import { classifyActionability } from "../agents/actionability-classifier.js";
import type { YardmasterConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: YardmasterConfig = {
  repos: [],
  dataDir: "/tmp/data",
  worktreeBaseDir: "/tmp/worktrees",
  claudeBinary: "claude",
  defaultModel: "sonnet",
  maxConcurrentAgents: 1,
  timeouts: {
    coder: 60_000,
    reviewer: 60_000,
    gitAgent: 60_000,
    diagnostician: 180_000,
    diagnosticianEscalated: 300_000,
  },
};

function agentSuccess(json: object) {
  return { success: true, result: JSON.stringify(json), error: undefined, durationMs: 100 };
}

function agentFailure(error: string) {
  return { success: false, result: "", error, durationMs: 100 };
}

// ---------------------------------------------------------------------------
// 1. buildActionabilityPrompt — pure function
// ---------------------------------------------------------------------------

describe("buildActionabilityPrompt", () => {
  it("includes the issue title", () => {
    const prompt = buildActionabilityPrompt("Fix login bug", "Details here", ["bug"]);
    expect(prompt).toContain("Fix login bug");
  });

  it("includes the issue body", () => {
    const prompt = buildActionabilityPrompt("Fix login bug", "Some body text", ["bug"]);
    expect(prompt).toContain("Some body text");
  });

  it("includes labels as a comma-separated list", () => {
    const prompt = buildActionabilityPrompt("Title", "Body", ["ym", "ym-high"]);
    expect(prompt).toContain("ym, ym-high");
  });

  it("shows 'none' when labels array is empty", () => {
    const prompt = buildActionabilityPrompt("Title", "Body", []);
    expect(prompt).toContain("none");
  });

  it("truncates body to 500 characters", () => {
    const longBody = "x".repeat(600);
    const prompt = buildActionabilityPrompt("Title", longBody, []);
    expect(prompt).toContain("x".repeat(500));
    expect(prompt).not.toContain("x".repeat(501));
  });

  it("includes instructions to return JSON", () => {
    const prompt = buildActionabilityPrompt("Title", "Body", []);
    expect(prompt).toContain('"actionable"');
    expect(prompt).toContain('"reason"');
  });

  it("body at exactly 500 characters is not truncated", () => {
    const body500 = "y".repeat(500);
    const prompt = buildActionabilityPrompt("Title", body500, []);
    expect(prompt).toContain(body500);
  });
});

// ---------------------------------------------------------------------------
// 2. ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT — spot checks
// ---------------------------------------------------------------------------

describe("ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT", () => {
  it("instructs the model to return JSON with actionable and reason fields", () => {
    expect(ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT).toContain('"actionable"');
    expect(ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT).toContain('"reason"');
  });

  it("mentions non-actionable criteria (meta, tracker, epic)", () => {
    const lower = ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("meta");
    expect(lower).toContain("tracker");
    expect(lower).toContain("epic");
  });

  it("instructs to default to actionable when in doubt", () => {
    expect(ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT.toLowerCase()).toContain("when in doubt");
  });
});

// ---------------------------------------------------------------------------
// 3. classifyActionability — agent wrapper
// ---------------------------------------------------------------------------

describe("classifyActionability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns actionable=true when agent returns { actionable: true }", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: true, reason: "It is a bug fix" })
    );
    const result = await classifyActionability(CONFIG, "Fix bug", "body", ["bug"]);
    expect(result.actionable).toBe(true);
    expect(result.reason).toBe("It is a bug fix");
  });

  it("returns actionable=false with reason when agent returns { actionable: false }", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: false, reason: "This is a tracker issue" })
    );
    const result = await classifyActionability(CONFIG, "meta: roadmap", "tracker only", []);
    expect(result.actionable).toBe(false);
    expect(result.reason).toBe("This is a tracker issue");
  });

  it("defaults reason to empty string when agent omits reason field", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: true })
    );
    const result = await classifyActionability(CONFIG, "Title", "body", []);
    expect(result.actionable).toBe(true);
    expect(result.reason).toBe("");
  });

  it("defaults reason to empty string when agent returns non-string reason", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: false, reason: 42 })
    );
    const result = await classifyActionability(CONFIG, "Title", "body", []);
    expect(result.actionable).toBe(false);
    expect(result.reason).toBe("");
  });

  it("fails open (actionable=true) when agent returns success=false", async () => {
    vi.mocked(runAgent).mockResolvedValue(agentFailure("timed out"));
    const result = await classifyActionability(CONFIG, "Title", "body", []);
    expect(result.actionable).toBe(true);
    expect(result.reason).toBe("");
  });

  it("fails open (actionable=true) when agent returns non-boolean actionable", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: "yes", reason: "ok" })
    );
    const result = await classifyActionability(CONFIG, "Title", "body", []);
    expect(result.actionable).toBe(true);
    expect(result.reason).toBe("");
  });

  it("fails open (actionable=true) when agent returns invalid JSON", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      result: "not-json",
      error: undefined,
      durationMs: 100,
    });
    const result = await classifyActionability(CONFIG, "Title", "body", []);
    expect(result.actionable).toBe(true);
    expect(result.reason).toBe("");
  });

  it("fails open (actionable=true) when runAgent throws", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("network error"));
    const result = await classifyActionability(CONFIG, "Title", "body", []);
    expect(result.actionable).toBe(true);
    expect(result.reason).toBe("");
  });

  it("passes haiku model and 60s timeout to runAgent", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: true, reason: "" })
    );
    await classifyActionability(CONFIG, "Title", "body", ["ym"]);
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({ model: "haiku", timeout: 60_000 })
    );
  });

  it("passes empty allowedTools to runAgent", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: true, reason: "" })
    );
    await classifyActionability(CONFIG, "Title", "body", []);
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({ allowedTools: [] })
    );
  });

  it("passes labels joined as strings to the prompt", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      agentSuccess({ actionable: true, reason: "" })
    );
    await classifyActionability(CONFIG, "Title", "body", ["ym", "bug"]);
    const callArgs = vi.mocked(runAgent).mock.calls[0]?.[1];
    expect(callArgs?.prompt).toContain("ym");
    expect(callArgs?.prompt).toContain("bug");
  });
});
