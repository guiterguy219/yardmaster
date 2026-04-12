import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoist mocks before any imports that touch the module under test
vi.mock("node:os", () => ({ homedir: () => "/home/testuser" }));
vi.mock("node:fs");

import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

/** Minimal valid repos.json payload (no maxConcurrentAgents). */
const MINIMAL_RAW = {
  repos: [{ name: "test-repo", path: "~/repos/test", org: "acme", repo: "test" }],
};

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// loadConfig — maxConcurrentAgents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// loadConfig — protectedFiles / protectedFunctions passthrough
// ---------------------------------------------------------------------------

describe("loadConfig — protected files config", () => {
  it("passes protectedFiles through to the repo config", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          protectedFiles: ["src/cli.ts", "src/task-runner.ts"],
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFiles).toEqual(["src/cli.ts", "src/task-runner.ts"]);
  });

  it("passes protectedFunctions through to the repo config", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          protectedFunctions: {
            "src/integration/docker.ts": ["generateComposeFile", "stopServices"],
          },
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFunctions).toEqual({
      "src/integration/docker.ts": ["generateComposeFile", "stopServices"],
    });
  });

  it("leaves protectedFiles and protectedFunctions undefined when absent", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFiles).toBeUndefined();
    expect(config.repos[0].protectedFunctions).toBeUndefined();
  });
});

describe("loadConfig — maxConcurrentAgents", () => {
  it("defaults to 1 when the field is absent from repos.json", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    const config = loadConfig();
    expect(config.maxConcurrentAgents).toBe(1);
  });

  it("reads the value from repos.json when set to 2", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ ...MINIMAL_RAW, maxConcurrentAgents: 2 }) as any,
    );
    const config = loadConfig();
    expect(config.maxConcurrentAgents).toBe(2);
  });

  it("reads arbitrary positive values (e.g. 4)", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ ...MINIMAL_RAW, maxConcurrentAgents: 4 }) as any,
    );
    const config = loadConfig();
    expect(config.maxConcurrentAgents).toBe(4);
  });

  it("keeps other config fields intact when maxConcurrentAgents is provided", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ ...MINIMAL_RAW, maxConcurrentAgents: 3 }) as any,
    );
    const config = loadConfig();
    expect(config.claudeBinary).toBe("claude");
    expect(config.defaultModel).toBe("sonnet");
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0].name).toBe("test-repo");
  });
});
