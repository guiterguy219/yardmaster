import { vi, describe, it, expect, beforeEach } from "vitest";

// Must be declared before importing the module under test so vi hoists the mock
vi.mock("node:os", () => ({ homedir: () => "/home/testuser" }));
vi.mock("node:fs");

import { existsSync, readFileSync } from "node:fs";
import { hasIntegrationConfig, integrationConfigPath, loadIntegrationConfig } from "./config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeYaml(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    enabled: true,
    services: {
      database: { type: "neon" },
      redis: { type: "docker-redis", image: "redis:7-alpine", ports: { 6379: 16379 } },
    },
    auth: { strategy: "mock-jwt" },
    testCommand: "npm test",
    testTimeout: 30000,
    ...overrides,
  };

  // Build minimal YAML manually so we don't depend on a YAML serialiser in tests
  const lines: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (k === "services" && typeof v === "object" && v !== null) {
      lines.push("services:");
      for (const [svcName, svcVal] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${svcName}:`);
        for (const [sk, sv] of Object.entries(svcVal as Record<string, unknown>)) {
          lines.push(`    ${sk}: ${sv}`);
        }
      }
    } else if (k === "auth" && typeof v === "object" && v !== null) {
      lines.push("auth:");
      for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${ak}: ${av}`);
      }
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n");
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// hasIntegrationConfig
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// integrationConfigPath
// ---------------------------------------------------------------------------

describe("integrationConfigPath", () => {
  it("returns a path ending in <repoName>.yml", () => {
    const path = integrationConfigPath("my-service");
    expect(path).toMatch(/my-service\.yml$/);
  });

  it("returns the same path as hasIntegrationConfig checks", () => {
    // Both functions share the same private configPath — verify consistency.
    mockExistsSync.mockReturnValue(false);
    hasIntegrationConfig("parity-repo");
    const checkedPath = mockExistsSync.mock.calls[0][0] as string;
    expect(integrationConfigPath("parity-repo")).toBe(checkedPath);
  });
});

describe("hasIntegrationConfig", () => {
  it("returns true when the config file exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(hasIntegrationConfig("my-repo")).toBe(true);
  });

  it("returns false when the config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(hasIntegrationConfig("my-repo")).toBe(false);
  });

  it("checks the correct path pattern (<repo>.yml)", () => {
    mockExistsSync.mockReturnValue(false);
    hasIntegrationConfig("cool-service");
    const checkedPath = mockExistsSync.mock.calls[0][0] as string;
    expect(checkedPath).toMatch(/cool-service\.yml$/);
  });
});

// ---------------------------------------------------------------------------
// loadIntegrationConfig — file missing
// ---------------------------------------------------------------------------

describe("loadIntegrationConfig — file missing", () => {
  it("returns null when the file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadIntegrationConfig("no-such-repo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadIntegrationConfig — valid YAML
// ---------------------------------------------------------------------------

describe("loadIntegrationConfig — valid config", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
  });

  it("parses a minimal valid config", () => {
    mockReadFileSync.mockReturnValue(makeYaml() as any);
    const cfg = loadIntegrationConfig("my-repo");
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.testCommand).toBe("npm test");
    expect(cfg!.testTimeout).toBe(30000);
  });

  it("parses services correctly", () => {
    mockReadFileSync.mockReturnValue(makeYaml() as any);
    const cfg = loadIntegrationConfig("my-repo");
    expect(cfg!.services).toHaveProperty("database");
    expect(cfg!.services["database"].type).toBe("neon");
    expect(cfg!.services).toHaveProperty("redis");
    expect(cfg!.services["redis"].type).toBe("docker-redis");
  });

  it("uses auth strategy from YAML", () => {
    const yaml = makeYaml({ auth: { strategy: "keycloak", clientId: "my-client" } });
    mockReadFileSync.mockReturnValue(yaml as any);
    const cfg = loadIntegrationConfig("my-repo");
    expect(cfg!.auth.strategy).toBe("keycloak");
    expect(cfg!.auth.clientId).toBe("my-client");
  });

  it("defaults auth.strategy to 'mock-jwt' when auth block is absent", () => {
    // Build YAML without an auth key
    const noAuthYaml = [
      "enabled: true",
      "services:",
      "  api:",
      "    type: api",
      "    url: http://localhost:3000",
      "testCommand: npm test",
    ].join("\n");
    mockReadFileSync.mockReturnValue(noAuthYaml as any);
    const cfg = loadIntegrationConfig("my-repo");
    expect(cfg!.auth.strategy).toBe("mock-jwt");
  });

  it("defaults testTimeout to 600_000 when not specified", () => {
    const noTimeoutYaml = [
      "enabled: true",
      "services:",
      "  api:",
      "    type: api",
      "    url: http://localhost:3000",
      "testCommand: npm test",
    ].join("\n");
    mockReadFileSync.mockReturnValue(noTimeoutYaml as any);
    const cfg = loadIntegrationConfig("my-repo");
    expect(cfg!.testTimeout).toBe(600_000);
  });

  it("uses explicit testTimeout when provided", () => {
    mockReadFileSync.mockReturnValue(makeYaml({ testTimeout: 120000 }) as any);
    const cfg = loadIntegrationConfig("my-repo");
    expect(cfg!.testTimeout).toBe(120000);
  });

  it("parses enabled: false correctly", () => {
    mockReadFileSync.mockReturnValue(makeYaml({ enabled: false }) as any);
    const cfg = loadIntegrationConfig("my-repo");
    expect(cfg!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadIntegrationConfig — validation errors
// ---------------------------------------------------------------------------

describe("loadIntegrationConfig — validation errors", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
  });

  it("throws when 'enabled' is not a boolean", () => {
    const bad = [
      "enabled: maybe",
      "services:",
      "  api:",
      "    type: api",
      "    url: http://localhost:3000",
      "testCommand: npm test",
    ].join("\n");
    mockReadFileSync.mockReturnValue(bad as any);
    expect(() => loadIntegrationConfig("bad-repo")).toThrow(/enabled.*boolean/i);
  });

  it("throws when 'services' is missing", () => {
    const bad = ["enabled: true", "testCommand: npm test"].join("\n");
    mockReadFileSync.mockReturnValue(bad as any);
    expect(() => loadIntegrationConfig("bad-repo")).toThrow(/services.*object/i);
  });

  it("throws when 'services' is an array instead of an object", () => {
    const bad = ["enabled: true", "services:", "  - foo", "testCommand: npm test"].join("\n");
    mockReadFileSync.mockReturnValue(bad as any);
    expect(() => loadIntegrationConfig("bad-repo")).toThrow(/services.*object/i);
  });

  it("throws when 'testCommand' is missing", () => {
    const bad = [
      "enabled: true",
      "services:",
      "  api:",
      "    type: api",
      "    url: http://localhost:3000",
    ].join("\n");
    mockReadFileSync.mockReturnValue(bad as any);
    expect(() => loadIntegrationConfig("bad-repo")).toThrow(/testCommand.*string/i);
  });

  it("includes the repo name in validation error messages", () => {
    mockReadFileSync.mockReturnValue("enabled: true\ntestCommand: npm test" as any);
    expect(() => loadIntegrationConfig("special-repo")).toThrow(/special-repo/);
  });
});
