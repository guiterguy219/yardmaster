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

// ---------------------------------------------------------------------------
// loadConfig — overagePolicy
// ---------------------------------------------------------------------------

describe("loadConfig — overagePolicy", () => {
  it("defaults overagePolicy to 'defer-low' when absent from repos.json", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    const config = loadConfig();
    expect(config.repos[0].overagePolicy).toBe("defer-low");
  });

  it("reads an explicit 'block-all' overagePolicy from repos.json", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          overagePolicy: "block-all",
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].overagePolicy).toBe("block-all");
  });

  it("reads an explicit 'defer-normal' overagePolicy from repos.json", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          overagePolicy: "defer-normal",
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].overagePolicy).toBe("defer-normal");
  });

  it("reads an explicit 'allow' overagePolicy from repos.json", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          overagePolicy: "allow",
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].overagePolicy).toBe("allow");
  });

  it("does not affect other repo fields when overagePolicy is set", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          overagePolicy: "defer-low",
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].name).toBe("test-repo");
    expect(config.repos[0].githubOrg).toBe("acme");
    expect(config.repos[0].overagePolicy).toBe("defer-low");
  });
});
