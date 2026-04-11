import { vi, describe, it, expect, beforeEach } from "vitest";

// Must be declared before importing the module under test so vi hoists the mocks
vi.mock("node:os", () => ({ homedir: () => "/home/testuser" }));
vi.mock("node:fs");
vi.mock("node:child_process");

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import yaml from "js-yaml";

import {
  getComposeDir,
  getComposePath,
  generateComposeFile,
  startServices,
  stopServices,
  isDockerAvailable,
} from "./docker.js";
import type { IntegrationConfig } from "./config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(services: IntegrationConfig["services"] = {}): IntegrationConfig {
  return {
    enabled: true,
    services,
    auth: { strategy: "mock-jwt" },
    testCommand: "npm test",
    testTimeout: 30000,
  };
}

/** Parse the YAML string captured by the writeFileSync mock */
function captureWrittenCompose(): Record<string, unknown> {
  const call = mockWriteFileSync.mock.calls[0];
  const content = call[1] as string;
  return yaml.load(content) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("getComposeDir", () => {
  it("returns the path under ~/code/gibson-ops/yardmaster/data/integration/<repo>", () => {
    expect(getComposeDir("my-repo")).toBe(
      "/home/testuser/code/gibson-ops/yardmaster/data/integration/my-repo"
    );
  });
});

describe("getComposePath", () => {
  it("returns docker-compose.yml inside the compose dir", () => {
    expect(getComposePath("my-repo")).toBe(
      "/home/testuser/code/gibson-ops/yardmaster/data/integration/my-repo/docker-compose.yml"
    );
  });
});

// ---------------------------------------------------------------------------
// generateComposeFile — directory and file creation
// ---------------------------------------------------------------------------

describe("generateComposeFile — directory and file creation", () => {
  it("creates the directory recursively before writing", () => {
    generateComposeFile("my-repo", makeConfig());
    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/home/testuser/code/gibson-ops/yardmaster/data/integration/my-repo",
      { recursive: true }
    );
  });

  it("writes the compose file to the correct path", () => {
    generateComposeFile("my-repo", makeConfig());
    const writePath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(writePath).toBe(
      "/home/testuser/code/gibson-ops/yardmaster/data/integration/my-repo/docker-compose.yml"
    );
  });

  it("returns the YAML string that was written to the file", () => {
    const result = generateComposeFile("my-repo", makeConfig());
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(result).toBe(written);
  });

  it("includes version '3.8' in the compose output", () => {
    generateComposeFile("my-repo", makeConfig());
    const composed = captureWrittenCompose();
    expect(composed.version).toBe("3.8");
  });

  it("skips non-docker service types (e.g. neon)", () => {
    const config = makeConfig({ db: { type: "neon" } });
    generateComposeFile("my-repo", config);
    const composed = captureWrittenCompose();
    const services = composed.services as Record<string, unknown>;
    expect(Object.keys(services)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateComposeFile — redis service
// ---------------------------------------------------------------------------

describe("generateComposeFile — redis service", () => {
  it("uses redis:7-alpine as the default image", () => {
    const config = makeConfig({ cache: { type: "docker-redis" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).cache as Record<string, unknown>;
    expect(svc.image).toBe("redis:7-alpine");
  });

  it("uses the specified image override", () => {
    const config = makeConfig({ cache: { type: "docker-redis", image: "redis:6-alpine" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).cache as Record<string, unknown>;
    expect(svc.image).toBe("redis:6-alpine");
  });

  it("includes a healthcheck using redis-cli ping", () => {
    const config = makeConfig({ cache: { type: "docker-redis" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).cache as Record<string, unknown>;
    const hc = svc.healthcheck as Record<string, unknown>;
    expect(hc.test).toEqual(["CMD", "redis-cli", "ping"]);
  });

  it("maps ports in host:container format", () => {
    const config = makeConfig({ cache: { type: "docker-redis", ports: { 6379: 16379 } } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).cache as Record<string, unknown>;
    expect(svc.ports).toEqual(["16379:6379"]);
  });

  it("maps multiple ports correctly", () => {
    const config = makeConfig({ cache: { type: "docker-redis", ports: { 6379: 16379, 6380: 16380 } } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).cache as Record<string, unknown>;
    const ports = svc.ports as string[];
    expect(ports).toContain("16379:6379");
    expect(ports).toContain("16380:6380");
  });

  it("omits ports property when no ports are specified", () => {
    const config = makeConfig({ cache: { type: "docker-redis" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).cache as Record<string, unknown>;
    expect(svc).not.toHaveProperty("ports");
  });
});

// ---------------------------------------------------------------------------
// generateComposeFile — postgres service
// ---------------------------------------------------------------------------

describe("generateComposeFile — postgres service", () => {
  it("uses postgres:16-alpine as the default image", () => {
    const config = makeConfig({ db: { type: "docker-postgres" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).db as Record<string, unknown>;
    expect(svc.image).toBe("postgres:16-alpine");
  });

  it("defaults POSTGRES_USER and POSTGRES_PASSWORD to 'test'", () => {
    const config = makeConfig({ db: { type: "docker-postgres" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).db as Record<string, unknown>;
    const env = svc.environment as Record<string, string>;
    expect(env.POSTGRES_USER).toBe("test");
    expect(env.POSTGRES_PASSWORD).toBe("test");
  });

  it("uses provided POSTGRES_USER and POSTGRES_PASSWORD from env", () => {
    const config = makeConfig({
      db: {
        type: "docker-postgres",
        env: { POSTGRES_USER: "myuser", POSTGRES_PASSWORD: "mypass" },
      },
    });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).db as Record<string, unknown>;
    const env = svc.environment as Record<string, string>;
    expect(env.POSTGRES_USER).toBe("myuser");
    expect(env.POSTGRES_PASSWORD).toBe("mypass");
  });

  it("includes pg_isready healthcheck using the configured user", () => {
    const config = makeConfig({
      db: { type: "docker-postgres", env: { POSTGRES_USER: "myuser", POSTGRES_PASSWORD: "secret" } },
    });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).db as Record<string, unknown>;
    const hc = svc.healthcheck as Record<string, unknown>;
    expect(hc.test).toEqual(["CMD", "pg_isready", "-U", "myuser"]);
  });

  it("uses default user 'test' in pg_isready healthcheck when no env provided", () => {
    const config = makeConfig({ db: { type: "docker-postgres" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).db as Record<string, unknown>;
    const hc = svc.healthcheck as Record<string, unknown>;
    expect(hc.test).toEqual(["CMD", "pg_isready", "-U", "test"]);
  });

  it("passes extra env vars through to the environment block", () => {
    const config = makeConfig({
      db: {
        type: "docker-postgres",
        env: { POSTGRES_USER: "u", POSTGRES_PASSWORD: "p", POSTGRES_DB: "mydb" },
      },
    });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).db as Record<string, unknown>;
    const env = svc.environment as Record<string, string>;
    expect(env.POSTGRES_DB).toBe("mydb");
  });
});

// ---------------------------------------------------------------------------
// generateComposeFile — keycloak service
// ---------------------------------------------------------------------------

describe("generateComposeFile — keycloak service", () => {
  it("uses the provided image (no default)", () => {
    const config = makeConfig({ keycloak: { type: "docker-keycloak", image: "quay.io/keycloak/keycloak:23" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).keycloak as Record<string, unknown>;
    expect(svc.image).toBe("quay.io/keycloak/keycloak:23");
  });

  it("declares depends_on postgres with service_healthy condition", () => {
    const config = makeConfig({ keycloak: { type: "docker-keycloak", image: "quay.io/keycloak/keycloak:23" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).keycloak as Record<string, unknown>;
    expect(svc.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
  });

  it("includes healthcheck targeting /health on port 8080", () => {
    const config = makeConfig({ keycloak: { type: "docker-keycloak", image: "quay.io/keycloak/keycloak:23" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).keycloak as Record<string, unknown>;
    const hc = svc.healthcheck as Record<string, unknown>;
    const testCmd = (hc.test as string[]).join(" ");
    expect(testCmd).toContain("http://localhost:8080/health");
  });

  it("sets environment block when env is provided", () => {
    const config = makeConfig({
      keycloak: {
        type: "docker-keycloak",
        image: "quay.io/keycloak/keycloak:23",
        env: { KC_DB: "postgres", KC_DB_URL: "jdbc:postgresql://db/kc" },
      },
    });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).keycloak as Record<string, unknown>;
    expect(svc.environment).toEqual({ KC_DB: "postgres", KC_DB_URL: "jdbc:postgresql://db/kc" });
  });

  it("omits environment when no env is provided", () => {
    const config = makeConfig({ keycloak: { type: "docker-keycloak", image: "quay.io/keycloak/keycloak:23" } });
    generateComposeFile("my-repo", config);
    const svc = (captureWrittenCompose().services as Record<string, unknown>).keycloak as Record<string, unknown>;
    expect(svc).not.toHaveProperty("environment");
  });
});

// ---------------------------------------------------------------------------
// generateComposeFile — mixed services
// ---------------------------------------------------------------------------

describe("generateComposeFile — mixed service types", () => {
  it("only includes docker-* services in the compose output", () => {
    const config = makeConfig({
      neonDb: { type: "neon" },
      cache: { type: "docker-redis" },
      db: { type: "docker-postgres" },
    });
    generateComposeFile("my-repo", config);
    const services = captureWrittenCompose().services as Record<string, unknown>;
    expect(Object.keys(services)).not.toContain("neonDb");
    expect(Object.keys(services)).toContain("cache");
    expect(Object.keys(services)).toContain("db");
  });
});

// ---------------------------------------------------------------------------
// startServices
// ---------------------------------------------------------------------------

describe("startServices", () => {
  it("returns started:false with empty services when no docker services are present", () => {
    const config = makeConfig({ db: { type: "neon" } });
    const result = startServices("my-repo", config);
    expect(result).toEqual({ started: false, services: [], error: undefined });
  });

  it("does not invoke docker when no docker services are present", () => {
    const config = makeConfig({ db: { type: "neon" } });
    startServices("my-repo", config);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("returns started:false with error message when generateComposeFile throws", () => {
    mockMkdirSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });
    const config = makeConfig({ cache: { type: "docker-redis" } });
    const result = startServices("my-repo", config);
    expect(result.started).toBe(false);
    expect(result.error).toMatch(/Permission denied/);
  });

  it("includes docker service names in the result when generateComposeFile throws", () => {
    mockMkdirSync.mockImplementation(() => {
      throw new Error("disk full");
    });
    const config = makeConfig({ cache: { type: "docker-redis" }, db: { type: "docker-postgres" } });
    const result = startServices("my-repo", config);
    expect(result.services).toContain("cache");
    expect(result.services).toContain("db");
  });

  it("calls docker compose up -d --wait with the compose file path", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    const config = makeConfig({ cache: { type: "docker-redis" } });
    startServices("my-repo", config);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "compose",
        "-f",
        expect.stringContaining("docker-compose.yml"),
        "up",
        "-d",
        "--wait",
      ]),
      expect.any(Object)
    );
  });

  it("returns started:true with all docker service names on success", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    const config = makeConfig({
      cache: { type: "docker-redis" },
      db: { type: "docker-postgres" },
    });
    const result = startServices("my-repo", config);
    expect(result.started).toBe(true);
    expect(result.services).toContain("cache");
    expect(result.services).toContain("db");
  });

  it("returns started:false with stderr when docker compose up fails", () => {
    const err = Object.assign(new Error("docker failed"), {
      stderr: Buffer.from("Error response from daemon: Cannot connect to Docker"),
    });
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const config = makeConfig({ cache: { type: "docker-redis" } });
    const result = startServices("my-repo", config);
    expect(result.started).toBe(false);
    expect(result.error).toContain("Error response from daemon");
  });

  it("returns 'Unknown error' when docker failure has no stderr property", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("oops");
    });
    const config = makeConfig({ cache: { type: "docker-redis" } });
    const result = startServices("my-repo", config);
    expect(result.started).toBe(false);
    expect(result.error).toBe("Unknown error");
  });

  it("sets a 120s timeout on the docker compose up command", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    const config = makeConfig({ cache: { type: "docker-redis" } });
    startServices("my-repo", config);
    const opts = mockExecFileSync.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// stopServices
// ---------------------------------------------------------------------------

describe("stopServices", () => {
  it("does nothing when the compose file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    stopServices("my-repo");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("checks the correct compose file path", () => {
    mockExistsSync.mockReturnValue(false);
    stopServices("my-repo");
    expect(mockExistsSync).toHaveBeenCalledWith(
      expect.stringContaining("docker-compose.yml")
    );
  });

  it("calls docker compose down -v when the compose file exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    stopServices("my-repo");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["compose", "-f", expect.stringContaining("docker-compose.yml"), "down", "-v"]),
      expect.any(Object)
    );
  });

  it("does not throw when docker compose down fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("compose error");
    });
    expect(() => stopServices("my-repo")).not.toThrow();
  });

  it("sets a 60s timeout on the docker compose down command", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    stopServices("my-repo");
    const opts = mockExecFileSync.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// isDockerAvailable
// ---------------------------------------------------------------------------

describe("isDockerAvailable", () => {
  it("returns true when 'docker info' succeeds", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));
    expect(isDockerAvailable()).toBe(true);
  });

  it("returns false when 'docker info' throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command not found: docker");
    });
    expect(isDockerAvailable()).toBe(false);
  });

  it("calls 'docker info' with stdio:pipe to suppress output", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));
    isDockerAvailable();
    expect(mockExecSync).toHaveBeenCalledWith("docker info", { stdio: "pipe" });
  });
});
