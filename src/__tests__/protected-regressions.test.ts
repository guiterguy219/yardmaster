/**
 * Tests for src/protected-regressions.ts — the "protected files" gate that
 * runs after the review loop and compares the worktree's branch against
 * `origin/<base>` (three-dot diff against merge-base) to block accidental
 * rewrites of load-bearing files (e.g. docker.ts).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { checkProtectedRegressions, formatViolations } from "../protected-regressions.js";
import type { RepoConfig } from "../config.js";

function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "test-repo",
    localPath: "/tmp/test-repo",
    githubOrg: "acme",
    githubRepo: "test-repo",
    defaultBranch: "main",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkProtectedRegressions — config gating", () => {
  it("returns ran=false when no protected lists are configured", () => {
    const result = checkProtectedRegressions(makeRepo(), "/tmp/wt");
    expect(result.ran).toBe(false);
    expect(result.violations).toEqual([]);
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("checkProtectedRegressions — protected files", () => {
  it("flags a modified protected file", () => {
    vi.mocked(execSync).mockReturnValueOnce(
      "src/integration/docker.ts\nsrc/cli.ts\n" as any
    );

    const result = checkProtectedRegressions(
      makeRepo({ protectedFiles: ["src/integration/docker.ts"] }),
      "/tmp/wt"
    );

    expect(result.ran).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({
      file: "src/integration/docker.ts",
      reason: "file is marked protected",
    });
  });

  it("does not flag when no protected file is in the diff", () => {
    vi.mocked(execSync).mockReturnValueOnce("src/cli.ts\nREADME.md\n" as any);

    const result = checkProtectedRegressions(
      makeRepo({ protectedFiles: ["src/integration/docker.ts"] }),
      "/tmp/wt"
    );

    expect(result.ran).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("uses three-dot diff against origin/<defaultBranch>", () => {
    vi.mocked(execSync).mockReturnValueOnce("" as any);

    checkProtectedRegressions(
      makeRepo({ protectedFiles: ["src/foo.ts"], defaultBranch: "trunk" }),
      "/tmp/wt"
    );

    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toBe("git diff --name-only origin/trunk...HEAD");
  });

  it("uses the supplied baseBranch when provided", () => {
    vi.mocked(execSync).mockReturnValueOnce("" as any);

    checkProtectedRegressions(
      makeRepo({ protectedFiles: ["src/foo.ts"] }),
      "/tmp/wt",
      "release-2.0"
    );

    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toBe("git diff --name-only origin/release-2.0...HEAD");
  });
});

describe("checkProtectedRegressions — protected functions", () => {
  it("flags a protected function whose body changed", () => {
    vi.mocked(execSync)
      .mockReturnValueOnce("src/integration/docker.ts\n" as any) // name-only
      .mockReturnValueOnce(
        [
          "diff --git a/src/integration/docker.ts b/src/integration/docker.ts",
          "--- a/src/integration/docker.ts",
          "+++ b/src/integration/docker.ts",
          "@@",
          "-function buildKeycloakService(svc) {",
          "+function buildKeycloakService(svc, opts) {",
          "   return {};",
          " }",
        ].join("\n") as any
      );

    const result = checkProtectedRegressions(
      makeRepo({
        protectedFunctions: {
          "src/integration/docker.ts": ["buildKeycloakService", "parseJdbcUrl"],
        },
      }),
      "/tmp/wt"
    );

    expect(result.ran).toBe(true);
    expect(result.violations).toEqual([
      {
        file: "src/integration/docker.ts",
        function: "buildKeycloakService",
        reason: 'protected function "buildKeycloakService" was modified',
      },
    ]);
  });

  it("does not flag protected functions in untouched files", () => {
    vi.mocked(execSync).mockReturnValueOnce("src/cli.ts\n" as any);

    const result = checkProtectedRegressions(
      makeRepo({
        protectedFunctions: {
          "src/integration/docker.ts": ["buildKeycloakService"],
        },
      }),
      "/tmp/wt"
    );

    expect(result.ran).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("does not flag a protected function when only context lines mention it", () => {
    vi.mocked(execSync)
      .mockReturnValueOnce("src/integration/docker.ts\n" as any)
      .mockReturnValueOnce(
        [
          "@@",
          " function buildKeycloakService(svc) {",
          "-  return null;",
          "+  return {};",
          " }",
        ].join("\n") as any
      );

    const result = checkProtectedRegressions(
      makeRepo({
        protectedFunctions: {
          "src/integration/docker.ts": ["buildKeycloakService"],
        },
      }),
      "/tmp/wt"
    );

    // The function name only appears on a context line (leading space), so we
    // do NOT flag it. The two added/removed lines belong to its body but don't
    // mention the function name — by design the heuristic is name-based.
    expect(result.violations).toEqual([]);
  });
});

describe("checkProtectedRegressions — error handling", () => {
  it("fail-opens (ran=false) when git diff throws", () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });

    const result = checkProtectedRegressions(
      makeRepo({ protectedFiles: ["src/foo.ts"] }),
      "/tmp/wt"
    );

    expect(result.ran).toBe(false);
    expect(result.violations).toEqual([]);
    expect(result.reason).toMatch(/git diff failed/);
  });

  it("returns no violations when nothing is changed", () => {
    vi.mocked(execSync).mockReturnValueOnce("" as any);

    const result = checkProtectedRegressions(
      makeRepo({ protectedFiles: ["src/foo.ts"] }),
      "/tmp/wt"
    );

    expect(result.ran).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("formatViolations", () => {
  it("formats file-level and function-level violations", () => {
    const out = formatViolations([
      { file: "src/a.ts", reason: "file is marked protected" },
      { file: "src/b.ts", function: "foo", reason: 'protected function "foo" was modified' },
    ]);
    expect(out).toContain("src/a.ts — file is marked protected");
    expect(out).toContain('src/b.ts::foo — protected function "foo" was modified');
  });
});
