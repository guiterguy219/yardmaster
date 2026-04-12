import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSerenaConfig, cleanupSerenaConfig } from "../serena.js";

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

describe("createSerenaConfig", () => {
  let configPath: string | undefined;

  afterEach(() => {
    if (configPath && existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it("writes a valid MCP config file and returns its path", () => {
    configPath = createSerenaConfig("/tmp/test-worktree");
    expect(existsSync(configPath)).toBe(true);

    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content).toHaveProperty("mcpServers.serena");

    const serena = content.mcpServers.serena;
    expect(serena.type).toBe("stdio");
    expect(serena.command).toBe("uvx");
    expect(serena.args).toContain("serena");
    expect(serena.args).toContain("start-mcp-server");
    expect(serena.args).toContain("/tmp/test-worktree");
  });

  it("includes --project pointing to the worktree path", () => {
    const worktree = "/home/user/code/my-project/data/worktrees/ym-abc123";
    configPath = createSerenaConfig(worktree);

    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    const args: string[] = content.mcpServers.serena.args;
    const projectIdx = args.indexOf("--project");
    expect(projectIdx).toBeGreaterThan(-1);
    expect(args[projectIdx + 1]).toBe(worktree);
  });

  it("includes --from with the pinned serena package URL", () => {
    configPath = createSerenaConfig("/tmp/test-worktree");

    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    const args: string[] = content.mcpServers.serena.args;
    const fromIdx = args.indexOf("--from");
    expect(fromIdx).toBeGreaterThan(-1);
    expect(args[fromIdx + 1]).toBe(
      "git+https://github.com/oraios/serena@v1.0.0",
    );
  });

  it("produces unique config files for concurrent calls", () => {
    const path1 = createSerenaConfig("/tmp/wt1");
    const path2 = createSerenaConfig("/tmp/wt2");

    expect(path1).not.toBe(path2);

    const content1 = JSON.parse(readFileSync(path1, "utf-8"));
    const content2 = JSON.parse(readFileSync(path2, "utf-8"));
    expect(content1.mcpServers.serena.args).toContain("/tmp/wt1");
    expect(content2.mcpServers.serena.args).toContain("/tmp/wt2");

    // Clean up
    if (existsSync(path1)) unlinkSync(path1);
    if (existsSync(path2)) unlinkSync(path2);
    configPath = undefined;
  });

  it("writes config to the system temp directory", () => {
    configPath = createSerenaConfig("/tmp/wt");
    expect(configPath.startsWith(tmpdir())).toBe(true);
    expect(configPath).toMatch(/ym-serena-[0-9a-f-]+\.json$/);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("cleanupSerenaConfig", () => {
  it("removes the config file", () => {
    const path = join(tmpdir(), `ym-serena-test-cleanup-${Date.now()}.json`);
    writeFileSync(path, "{}");
    expect(existsSync(path)).toBe(true);

    cleanupSerenaConfig(path);
    expect(existsSync(path)).toBe(false);
  });

  it("does not throw for non-existent file", () => {
    expect(() => {
      cleanupSerenaConfig("/tmp/does-not-exist-ym-serena.json");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Agent runner: --mcp-config arg passing
// ---------------------------------------------------------------------------

describe("agent-runner MCP config", () => {
  const mockSpawn = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes --mcp-config in args when mcpConfigPath is provided", async () => {
    // Track spawn args by mocking child_process
    vi.doMock("node:child_process", () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === "close") setTimeout(() => cb(0), 10);
        }),
        killed: false,
        kill: vi.fn(),
        stdin: { end: vi.fn() },
      };
      mockSpawn.mockReturnValue(mockChild);
      return { spawn: mockSpawn };
    });

    const { runAgent } = await import("../agent-runner.js");
    const config = {
      claudeBinary: "claude",
      defaultModel: "sonnet",
      dataDir: "/tmp",
      repos: [],
      maxConcurrentAgents: 1,
      worktreeBaseDir: "/tmp/worktrees",
      timeouts: { coder: 600000, reviewer: 300000, gitAgent: 180000, diagnostician: 180000, diagnosticianEscalated: 300000 },
    };

    await runAgent(config, {
      prompt: "test prompt",
      systemPrompt: "test system",
      workingDir: "/tmp",
      timeout: 5000,
      mcpConfigPath: "/tmp/mcp-config.json",
    });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const mcpIdx = spawnArgs.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(spawnArgs[mcpIdx + 1]).toBe("/tmp/mcp-config.json");
  });

  it("does not include --mcp-config when mcpConfigPath is undefined", async () => {
    vi.doMock("node:child_process", () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === "close") setTimeout(() => cb(0), 10);
        }),
        killed: false,
        kill: vi.fn(),
        stdin: { end: vi.fn() },
      };
      mockSpawn.mockReturnValue(mockChild);
      return { spawn: mockSpawn };
    });

    const { runAgent } = await import("../agent-runner.js");
    const config = {
      claudeBinary: "claude",
      defaultModel: "sonnet",
      dataDir: "/tmp",
      repos: [],
      maxConcurrentAgents: 1,
      worktreeBaseDir: "/tmp/worktrees",
      timeouts: { coder: 600000, reviewer: 300000, gitAgent: 180000, diagnostician: 180000, diagnosticianEscalated: 300000 },
    };

    await runAgent(config, {
      prompt: "test prompt",
      systemPrompt: "test system",
      workingDir: "/tmp",
      timeout: 5000,
    });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("--mcp-config");
  });
});

// ---------------------------------------------------------------------------
// Coder agent: Serena lifecycle
// ---------------------------------------------------------------------------

describe("coder Serena integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes mcpConfigPath to runAgent when useSerena is true", async () => {
    const mockRunAgent = vi.fn().mockResolvedValue({
      success: true,
      result: "done",
      durationMs: 1000,
    });

    vi.doMock("../agent-runner.js", () => ({
      runAgent: mockRunAgent,
    }));
    vi.doMock("../prompts/coder.js", () => ({
      CODER_SYSTEM_PROMPT: "system",
      buildCoderPrompt: () => "prompt",
    }));

    const { runCoder } = await import("../agents/coder.js");
    const config = {
      claudeBinary: "claude",
      defaultModel: "sonnet",
      dataDir: "/tmp",
      repos: [],
      maxConcurrentAgents: 1,
      worktreeBaseDir: "/tmp/worktrees",
      timeouts: { coder: 600000, reviewer: 300000, gitAgent: 180000, diagnostician: 180000, diagnosticianEscalated: 300000 },
    };
    const repo = {
      name: "test",
      localPath: "/tmp/test",
      githubOrg: "org",
      githubRepo: "repo",
      defaultBranch: "main",
      useSerena: true,
    };

    await runCoder(config, repo, "do something", "/tmp/worktree");

    const opts = mockRunAgent.mock.calls[0][1];
    expect(opts.mcpConfigPath).toBeDefined();
    expect(opts.mcpConfigPath).toMatch(/ym-serena-[0-9a-f-]+\.json/);

    // Config file should be cleaned up after agent completes
    expect(existsSync(opts.mcpConfigPath)).toBe(false);
  });

  it("does not create MCP config when useSerena is false", async () => {
    const mockRunAgent = vi.fn().mockResolvedValue({
      success: true,
      result: "done",
      durationMs: 1000,
    });

    vi.doMock("../agent-runner.js", () => ({
      runAgent: mockRunAgent,
    }));
    vi.doMock("../prompts/coder.js", () => ({
      CODER_SYSTEM_PROMPT: "system",
      buildCoderPrompt: () => "prompt",
    }));

    const { runCoder } = await import("../agents/coder.js");
    const config = {
      claudeBinary: "claude",
      defaultModel: "sonnet",
      dataDir: "/tmp",
      repos: [],
      maxConcurrentAgents: 1,
      worktreeBaseDir: "/tmp/worktrees",
      timeouts: { coder: 600000, reviewer: 300000, gitAgent: 180000, diagnostician: 180000, diagnosticianEscalated: 300000 },
    };
    const repo = {
      name: "test",
      localPath: "/tmp/test",
      githubOrg: "org",
      githubRepo: "repo",
      defaultBranch: "main",
    };

    await runCoder(config, repo, "do something", "/tmp/worktree");

    const opts = mockRunAgent.mock.calls[0][1];
    expect(opts.mcpConfigPath).toBeUndefined();
  });

  it("cleans up MCP config even when agent throws", async () => {
    const mockRunAgent = vi.fn().mockRejectedValue(new Error("agent failed"));

    vi.doMock("../agent-runner.js", () => ({
      runAgent: mockRunAgent,
    }));
    vi.doMock("../prompts/coder.js", () => ({
      CODER_SYSTEM_PROMPT: "system",
      buildCoderPrompt: () => "prompt",
    }));

    const { runCoder } = await import("../agents/coder.js");
    const config = {
      claudeBinary: "claude",
      defaultModel: "sonnet",
      dataDir: "/tmp",
      repos: [],
      maxConcurrentAgents: 1,
      worktreeBaseDir: "/tmp/worktrees",
      timeouts: { coder: 600000, reviewer: 300000, gitAgent: 180000, diagnostician: 180000, diagnosticianEscalated: 300000 },
    };
    const repo = {
      name: "test",
      localPath: "/tmp/test",
      githubOrg: "org",
      githubRepo: "repo",
      defaultBranch: "main",
      useSerena: true,
    };

    // Capture the config path before the error
    let capturedPath: string | undefined;
    mockRunAgent.mockImplementation(
      (_config: unknown, opts: { mcpConfigPath?: string }) => {
        capturedPath = opts.mcpConfigPath;
        return Promise.reject(new Error("agent failed"));
      },
    );

    await expect(
      runCoder(config, repo, "do something", "/tmp/worktree"),
    ).rejects.toThrow("agent failed");

    // Config file should still be cleaned up
    expect(capturedPath).toBeDefined();
    expect(existsSync(capturedPath!)).toBe(false);
  });
});
