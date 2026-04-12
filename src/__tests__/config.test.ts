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

// ---------------------------------------------------------------------------
// loadConfig — protectedFiles
// ---------------------------------------------------------------------------

describe("loadConfig — protectedFiles", () => {
  it("is undefined when not set in repos.json", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFiles).toBeUndefined();
  });

  it("loads a non-empty array from repos.json", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          protectedFiles: ["src/integration/docker.ts", "src/cli.ts"],
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFiles).toEqual(["src/integration/docker.ts", "src/cli.ts"]);
  });

  it("loads an empty array without converting it to undefined", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          protectedFiles: [],
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — protectedFunctions
// ---------------------------------------------------------------------------

describe("loadConfig — protectedFunctions", () => {
  it("is undefined when not set in repos.json", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFunctions).toBeUndefined();
  });

  it("loads a function map from repos.json", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          protectedFunctions: {
            "src/integration/docker.ts": ["buildKeycloakService", "parseJdbcUrl"],
          },
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFunctions).toEqual({
      "src/integration/docker.ts": ["buildKeycloakService", "parseJdbcUrl"],
    });
  });

  it("loads a map covering multiple files", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          protectedFunctions: {
            "src/a.ts": ["fnA"],
            "src/b.ts": ["fnB1", "fnB2"],
          },
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].protectedFunctions).toEqual({
      "src/a.ts": ["fnA"],
      "src/b.ts": ["fnB1", "fnB2"],
    });
  });

  it("does not affect other repo fields when protectedFunctions is set", () => {
    const raw = {
      repos: [
        {
          name: "test-repo",
          path: "~/repos/test",
          org: "acme",
          repo: "test",
          protectedFunctions: { "src/foo.ts": ["bar"] },
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    expect(config.repos[0].name).toBe("test-repo");
    expect(config.repos[0].overagePolicy).toBe("defer-low");
  });
});

// ---------------------------------------------------------------------------
// loadConfig — integrationStrategy
// ---------------------------------------------------------------------------

describe("loadConfig — integrationStrategy", () => {
  it("defaults to 'ask-agent' when integrationStrategy is absent", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    const config = loadConfig();
    expect(config.repos[0].integrationStrategy).toBe("ask-agent");
  });

  it("emits a console.warn when integrationStrategy is absent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    loadConfig();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ask-agent"));
    warnSpy.mockRestore();
  });

  it.each(["full-docker", "test-suite", "smoke", "self-exec", "ask-agent"] as const)(
    "accepts valid strategy '%s'",
    (strategy) => {
      const raw = {
        repos: [{ name: "r", path: "~/r", org: "o", repo: "r", integrationStrategy: strategy }],
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
      const config = loadConfig();
      expect(config.repos[0].integrationStrategy).toBe(strategy);
    },
  );

  it("throws on an invalid integrationStrategy value", () => {
    const raw = {
      repos: [{ name: "r", path: "~/r", org: "o", repo: "r", integrationStrategy: "nonexistent" }],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    expect(() => loadConfig()).toThrow(/Invalid integrationStrategy/);
  });

  it("includes the invalid value and repo name in the error message", () => {
    const raw = {
      repos: [{ name: "my-repo", path: "~/r", org: "o", repo: "r", integrationStrategy: "bad-value" }],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    expect(() => loadConfig()).toThrow(/bad-value/);
  });

  it("passes through integrationTestCommand, smokeCommand, smokeTimeoutMs, buildCommand", () => {
    const raw = {
      repos: [
        {
          name: "r",
          path: "~/r",
          org: "o",
          repo: "r",
          integrationStrategy: "smoke",
          integrationTestCommand: "npm run test:e2e",
          smokeCommand: "node dist/cli.js --help",
          smokeTimeoutMs: 30_000,
          buildCommand: "npm run build",
        },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(raw) as any);
    const config = loadConfig();
    const repo = config.repos[0];
    expect(repo.integrationTestCommand).toBe("npm run test:e2e");
    expect(repo.smokeCommand).toBe("node dist/cli.js --help");
    expect(repo.smokeTimeoutMs).toBe(30_000);
    expect(repo.buildCommand).toBe("npm run build");
  });

  it("leaves new fields undefined when absent from repos.json", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MINIMAL_RAW) as any);
    const config = loadConfig();
    const repo = config.repos[0];
    expect(repo.integrationTestCommand).toBeUndefined();
    expect(repo.smokeCommand).toBeUndefined();
    expect(repo.smokeTimeoutMs).toBeUndefined();
    expect(repo.buildCommand).toBeUndefined();
  });
});
