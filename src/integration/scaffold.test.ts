import { vi, describe, it, expect, beforeEach } from "vitest";

// Must be declared before importing the module under test so vi hoists the mocks
vi.mock("node:fs");

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { scaffoldIntegrationTests } from "./scaffold.js";
import type { RepoConfig } from "../config.js";
import type { IntegrationConfig } from "./config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(localPath = "/repos/my-app"): RepoConfig {
  return {
    name: "my-app",
    localPath,
    githubOrg: "test-org",
    githubRepo: "my-app",
    defaultBranch: "main",
  };
}

function makeConfig(): IntegrationConfig {
  return {
    enabled: true,
    services: {},
    auth: { strategy: "mock-jwt" },
    testCommand: "npm test",
    testTimeout: 30000,
  };
}

const EXPECTED_RELATIVE_PATHS = [
  "test/jest-integration.json",
  "test/integration/test-utils.ts",
  "test/integration/health.integration-spec.ts",
];

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// All files absent — everything gets created
// ---------------------------------------------------------------------------

describe("scaffoldIntegrationTests — no files exist", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
  });

  it("returns all three relative paths in filesCreated", () => {
    const result = scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(result.filesCreated).toEqual(EXPECTED_RELATIVE_PATHS);
  });

  it("returns an empty filesSkipped array", () => {
    const result = scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(result.filesSkipped).toHaveLength(0);
  });

  it("calls mkdirSync once per file with { recursive: true }", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(mockMkdirSync).toHaveBeenCalledTimes(3);
    for (const call of mockMkdirSync.mock.calls) {
      expect(call[1]).toEqual({ recursive: true });
    }
  });

  it("calls writeFileSync once per file with utf-8 encoding", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
    for (const call of mockWriteFileSync.mock.calls) {
      expect(call[2]).toBe("utf-8");
    }
  });

  it("writes each file to the correct full path under repo.localPath", () => {
    const repo = makeRepo("/repos/my-app");
    scaffoldIntegrationTests(repo, makeConfig());
    const writtenPaths = mockWriteFileSync.mock.calls.map((c) => c[0] as string);
    for (const rel of EXPECTED_RELATIVE_PATHS) {
      expect(writtenPaths).toContain(join("/repos/my-app", rel));
    }
  });

  it("creates directory using dirname of the full file path", () => {
    const repo = makeRepo("/repos/my-app");
    scaffoldIntegrationTests(repo, makeConfig());
    const createdDirs = mockMkdirSync.mock.calls.map((c) => c[0] as string);
    for (const rel of EXPECTED_RELATIVE_PATHS) {
      const expectedDir = dirname(join("/repos/my-app", rel));
      expect(createdDirs).toContain(expectedDir);
    }
  });
});

// ---------------------------------------------------------------------------
// All files already exist — everything gets skipped
// ---------------------------------------------------------------------------

describe("scaffoldIntegrationTests — all files exist", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
  });

  it("returns all three relative paths in filesSkipped", () => {
    const result = scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(result.filesSkipped).toEqual(EXPECTED_RELATIVE_PATHS);
  });

  it("returns an empty filesCreated array", () => {
    const result = scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(result.filesCreated).toHaveLength(0);
  });

  it("never calls mkdirSync when all files exist", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("never calls writeFileSync when all files exist", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mixed: first file exists, remaining two do not
// ---------------------------------------------------------------------------

describe("scaffoldIntegrationTests — partial overlap", () => {
  it("skips existing files and creates missing ones", () => {
    // First file exists, second and third do not
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const result = scaffoldIntegrationTests(makeRepo(), makeConfig());

    expect(result.filesSkipped).toEqual([EXPECTED_RELATIVE_PATHS[0]]);
    expect(result.filesCreated).toEqual([
      EXPECTED_RELATIVE_PATHS[1],
      EXPECTED_RELATIVE_PATHS[2],
    ]);
  });

  it("calls writeFileSync only for missing files", () => {
    mockExistsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    scaffoldIntegrationTests(makeRepo(), makeConfig());
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Path construction uses repo.localPath correctly
// ---------------------------------------------------------------------------

describe("scaffoldIntegrationTests — path construction", () => {
  it("uses a different localPath when provided", () => {
    mockExistsSync.mockReturnValue(false);
    const repo = makeRepo("/custom/path/to/project");
    scaffoldIntegrationTests(repo, makeConfig());

    const writtenPaths = mockWriteFileSync.mock.calls.map((c) => c[0] as string);
    for (const rel of EXPECTED_RELATIVE_PATHS) {
      expect(writtenPaths).toContain(join("/custom/path/to/project", rel));
    }
  });

  it("checks existsSync against the full path including repo.localPath", () => {
    mockExistsSync.mockReturnValue(false);
    const repo = makeRepo("/repos/my-app");
    scaffoldIntegrationTests(repo, makeConfig());

    const checkedPaths = mockExistsSync.mock.calls.map((c) => c[0] as string);
    for (const rel of EXPECTED_RELATIVE_PATHS) {
      expect(checkedPaths).toContain(join("/repos/my-app", rel));
    }
  });
});

// ---------------------------------------------------------------------------
// File contents are non-empty strings
// ---------------------------------------------------------------------------

describe("scaffoldIntegrationTests — file contents", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
  });

  it("writes non-empty content for every file", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    for (const call of mockWriteFileSync.mock.calls) {
      const content = call[1] as string;
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("writes jest config content containing moduleFileExtensions", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    const jestConfigCall = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith("jest-integration.json")
    );
    expect(jestConfigCall).toBeDefined();
    const content = jestConfigCall![1] as string;
    expect(content).toContain("moduleFileExtensions");
  });

  it("writes test-utils content containing setupTestApp", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    const utilsCall = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith("test-utils.ts")
    );
    expect(utilsCall).toBeDefined();
    const content = utilsCall![1] as string;
    expect(content).toContain("setupTestApp");
  });

  it("writes health spec content containing Health Check", () => {
    scaffoldIntegrationTests(makeRepo(), makeConfig());
    const healthCall = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith("health.integration-spec.ts")
    );
    expect(healthCall).toBeDefined();
    const content = healthCall![1] as string;
    expect(content).toContain("Health Check");
  });
});
