/**
 * Tests for:
 *   src/new-project/scaffold.ts   — runScaffold input validation
 *   src/new-project/discovery.ts  — extractSpecFromFile fast path (raw JSON)
 *   src/new-project/claude-md-generator.ts — generateClaudeMd agent wrapper
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports
// ---------------------------------------------------------------------------

// Mock node:fs so readFileSync is controllable and filesystem is never touched.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// Mock agent-runner so no real Claude CLI processes are spawned.
vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { runAgent } from "../agent-runner.js";
import type { AgentRunResult } from "../agent-runner.js";
import { runScaffold } from "../new-project/scaffold.js";
import { extractSpecFromFile } from "../new-project/discovery.js";
import { generateClaudeMd } from "../new-project/claude-md-generator.js";
import type { ProjectSpec } from "../new-project/types.js";
import type { YardmasterConfig as Cfg } from "../config.js";

const mockRunAgent = vi.mocked(runAgent);
const mockReadFileSync = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG: Cfg = {
  // satisfies YardmasterConfig
  repos: [],
  dataDir: "/data",
  worktreeBaseDir: "/data/worktrees",
  claudeBinary: "claude",
  defaultModel: "sonnet",
  maxConcurrentAgents: 1,
  timeouts: {
    coder: 600_000,
    reviewer: 300_000,
    gitAgent: 180_000,
    diagnostician: 300_000,
    diagnosticianEscalated: 600_000,
  },
};

const VALID_SPEC: ProjectSpec = {
  name: "my-app",
  description: "Test project",
  githubOrg: "acme",
  platform: "web",
  framework: "next",
  language: "typescript",
  darkMode: false,
};

// ---------------------------------------------------------------------------
// runScaffold — input validation (no I/O needed; throws before any filesystem ops)
// ---------------------------------------------------------------------------

describe("runScaffold — missing required fields", () => {
  it("throws when name is empty", async () => {
    const spec = { ...VALID_SPEC, name: "" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "missing required fields"
    );
  });

  it("throws when githubOrg is empty", async () => {
    const spec = { ...VALID_SPEC, githubOrg: "" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "missing required fields"
    );
  });

  it("throws when framework is empty", async () => {
    const spec = { ...VALID_SPEC, framework: "" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "missing required fields"
    );
  });
});

describe("runScaffold — spec.name validation (shell safety)", () => {
  it("throws for name with uppercase letters", async () => {
    const spec = { ...VALID_SPEC, name: "MyApp" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid spec.name"
    );
  });

  it("throws for name with spaces", async () => {
    const spec = { ...VALID_SPEC, name: "my app" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid spec.name"
    );
  });

  it("throws for name with underscores", async () => {
    const spec = { ...VALID_SPEC, name: "my_app" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid spec.name"
    );
  });

  it("throws for name starting with a hyphen", async () => {
    const spec = { ...VALID_SPEC, name: "-myapp" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid spec.name"
    );
  });

  it("throws for name containing shell metacharacters", async () => {
    const spec = { ...VALID_SPEC, name: "my;app" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid spec.name"
    );
  });
});

describe("runScaffold — spec.githubOrg validation (shell safety)", () => {
  it("throws for org with uppercase letters", async () => {
    const spec = { ...VALID_SPEC, githubOrg: "Acme" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid spec.githubOrg"
    );
  });

  it("throws for org with spaces", async () => {
    const spec = { ...VALID_SPEC, githubOrg: "my org" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid spec.githubOrg"
    );
  });

  it("accepts a valid lowercase kebab-case org", async () => {
    // Validation passes; failure comes from filesystem (existsSync mock returns false → mkdirSync called)
    // We just verify the error is NOT a validation error.
    const spec = { ...VALID_SPEC, githubOrg: "my-org" };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.not.toThrow(
      "Invalid spec.githubOrg"
    );
  });
});

describe("runScaffold — additionalDeps / additionalDevDeps validation", () => {
  it("throws for an additionalDep with shell metacharacters", async () => {
    const spec = { ...VALID_SPEC, additionalDeps: ["rm -rf /"] };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid additionalDeps package name"
    );
  });

  it("throws for an additionalDevDep with shell metacharacters", async () => {
    const spec = { ...VALID_SPEC, additionalDevDeps: ["evil;pkg"] };
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.toThrow(
      "Invalid additionalDevDeps package name"
    );
  });

  it("accepts valid scoped npm package names", async () => {
    const spec = { ...VALID_SPEC, additionalDeps: ["@types/node", "react"] };
    // Validation passes; error comes from filesystem/shell
    await expect(runScaffold(MINIMAL_CONFIG, spec)).rejects.not.toThrow(
      "Invalid additionalDeps"
    );
  });
});

// ---------------------------------------------------------------------------
// extractSpecFromFile — fast path: file already contains raw JSON
// ---------------------------------------------------------------------------

describe("extractSpecFromFile — raw JSON fast path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the spec directly when file contains valid JSON with name and framework", async () => {
    const rawSpec: ProjectSpec = {
      name: "camplist",
      description: "Camp app",
      githubOrg: "acme",
      platform: "mobile",
      framework: "expo",
      language: "typescript",
      darkMode: true,
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(rawSpec) as unknown as ReturnType<typeof readFileSync>);

    const result = await extractSpecFromFile(MINIMAL_CONFIG, "/path/to/spec.json");
    expect(result).toEqual(rawSpec);
    // No agent should be called on the fast path
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns the spec when wrapped in a json fence block", async () => {
    const rawSpec: ProjectSpec = {
      name: "my-project",
      description: "Test",
      githubOrg: "org",
      platform: "api",
      framework: "express",
      language: "typescript",
      darkMode: false,
    };
    const fenced = "```json\n" + JSON.stringify(rawSpec) + "\n```";
    mockReadFileSync.mockReturnValue(fenced as unknown as ReturnType<typeof readFileSync>);

    const result = await extractSpecFromFile(MINIMAL_CONFIG, "/path/spec.md");
    expect(result.name).toBe("my-project");
    expect(result.framework).toBe("express");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("falls through to the agent when JSON is missing required name field", async () => {
    // JSON is parseable but lacks 'name' as a string → fast path skipped → agent called
    const partialJson = JSON.stringify({ framework: "next", description: "test" });
    mockReadFileSync.mockReturnValue(partialJson as unknown as ReturnType<typeof readFileSync>);

    const agentSpec: ProjectSpec = {
      name: "inferred-name",
      description: "test",
      githubOrg: "",
      platform: "web",
      framework: "next",
      language: "typescript",
      darkMode: false,
    };
    mockRunAgent.mockResolvedValue({
      success: true,
      result: "```json\n" + JSON.stringify(agentSpec) + "\n```",
      durationMs: 100,
    } satisfies AgentRunResult);

    const result = await extractSpecFromFile(MINIMAL_CONFIG, "/path/spec.md");
    expect(result.name).toBe("inferred-name");
    expect(mockRunAgent).toHaveBeenCalledOnce();
  });

  it("falls through to agent when file content is plain markdown (no JSON)", async () => {
    mockReadFileSync.mockReturnValue(
      "# My Project\n\nA cool app.\n" as unknown as ReturnType<typeof readFileSync>
    );

    const agentSpec: ProjectSpec = {
      name: "my-project",
      description: "A cool app",
      githubOrg: "",
      platform: "web",
      framework: "next",
      language: "typescript",
      darkMode: false,
    };
    mockRunAgent.mockResolvedValue({
      success: true,
      result: "```json\n" + JSON.stringify(agentSpec) + "\n```",
      durationMs: 200,
    } satisfies AgentRunResult);

    const result = await extractSpecFromFile(MINIMAL_CONFIG, "/path/spec.md");
    expect(result.name).toBe("my-project");
    expect(mockRunAgent).toHaveBeenCalledOnce();
  });

  it("throws when the agent fails", async () => {
    mockReadFileSync.mockReturnValue(
      "some markdown spec" as unknown as ReturnType<typeof readFileSync>
    );
    mockRunAgent.mockResolvedValue({
      success: false,
      result: "",
      durationMs: 50,
      error: "timeout",
    } satisfies AgentRunResult);

    await expect(extractSpecFromFile(MINIMAL_CONFIG, "/path/spec.md")).rejects.toThrow(
      "Spec extraction agent failed"
    );
  });

  it("throws when the agent returns non-JSON output", async () => {
    mockReadFileSync.mockReturnValue(
      "some markdown spec" as unknown as ReturnType<typeof readFileSync>
    );
    mockRunAgent.mockResolvedValue({
      success: true,
      result: "I could not extract a spec.",
      durationMs: 50,
    } satisfies AgentRunResult);

    await expect(extractSpecFromFile(MINIMAL_CONFIG, "/path/spec.md")).rejects.toThrow(
      "valid ProjectSpec JSON"
    );
  });
});

// ---------------------------------------------------------------------------
// generateClaudeMd — agent wrapper
// ---------------------------------------------------------------------------

describe("generateClaudeMd", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the agent's text output on success", async () => {
    const expectedContent = "# My App\n\nThis project uses Next.js.\n";
    mockRunAgent.mockResolvedValue({
      success: true,
      result: expectedContent,
      durationMs: 500,
    } satisfies AgentRunResult);

    const result = await generateClaudeMd(MINIMAL_CONFIG, VALID_SPEC);
    expect(result).toBe(expectedContent.trim());
  });

  it("strips a markdown fence wrapping the entire output", async () => {
    const inner = "# My App\n\nNext.js project.";
    const fenced = "```markdown\n" + inner + "\n```";
    mockRunAgent.mockResolvedValue({
      success: true,
      result: fenced,
      durationMs: 300,
    } satisfies AgentRunResult);

    const result = await generateClaudeMd(MINIMAL_CONFIG, VALID_SPEC);
    expect(result).toBe(inner.trim());
    expect(result).not.toContain("```");
  });

  it("strips a plain (no language tag) fence wrapping the entire output", async () => {
    const inner = "# README\n\nContent here.";
    const fenced = "```\n" + inner + "\n```";
    mockRunAgent.mockResolvedValue({
      success: true,
      result: fenced,
      durationMs: 300,
    } satisfies AgentRunResult);

    const result = await generateClaudeMd(MINIMAL_CONFIG, VALID_SPEC);
    expect(result).toBe(inner.trim());
  });

  it("strips a ```md fence wrapping the entire output", async () => {
    const inner = "# Docs\n\nSome docs.";
    const fenced = "```md\n" + inner + "\n```";
    mockRunAgent.mockResolvedValue({
      success: true,
      result: fenced,
      durationMs: 200,
    } satisfies AgentRunResult);

    const result = await generateClaudeMd(MINIMAL_CONFIG, VALID_SPEC);
    expect(result).toBe(inner.trim());
  });

  it("throws when the agent reports failure", async () => {
    mockRunAgent.mockResolvedValue({
      success: false,
      result: "",
      durationMs: 100,
      error: "model overloaded",
    } satisfies AgentRunResult);

    await expect(generateClaudeMd(MINIMAL_CONFIG, VALID_SPEC)).rejects.toThrow(
      "CLAUDE.md generator failed"
    );
  });

  it("throws when the agent returns empty output", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      result: "   ",
      durationMs: 100,
    } satisfies AgentRunResult);

    await expect(generateClaudeMd(MINIMAL_CONFIG, VALID_SPEC)).rejects.toThrow(
      "CLAUDE.md generator returned empty output"
    );
  });

  it("calls runAgent with haiku model for speed — actually uses sonnet per contract", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      result: "# Project",
      durationMs: 400,
    } satisfies AgentRunResult);

    await generateClaudeMd(MINIMAL_CONFIG, VALID_SPEC);

    const callArgs = mockRunAgent.mock.calls[0];
    expect(callArgs[1].model).toBe("sonnet");
    expect(callArgs[1].allowedTools).toEqual([]);
  });
});
