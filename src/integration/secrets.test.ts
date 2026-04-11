import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:fs");

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  loadSecrets,
  saveSecrets,
  getSecret,
  setSecret,
  resolveSecrets,
  buildIntegrationEnv,
} from "./secrets.js";
import type { IntegrationConfig, IntegrationServiceConfig } from "./config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(services: Record<string, IntegrationServiceConfig>): IntegrationConfig {
  return {
    enabled: true,
    services,
    auth: { strategy: "mock-jwt" },
    testCommand: "npm test",
    testTimeout: 600_000,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// loadSecrets
// ---------------------------------------------------------------------------

describe("loadSecrets", () => {
  it("returns an empty object when the secrets file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadSecrets("my-repo")).toEqual({});
  });

  it("returns parsed JSON when the file exists and is valid", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ DB_URL: "postgres://user:pass@host/db" }) as unknown as Buffer
    );
    expect(loadSecrets("my-repo")).toEqual({ DB_URL: "postgres://user:pass@host/db" });
  });

  it("returns an empty object when the file contains invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not-json{{{" as unknown as Buffer);
    expect(loadSecrets("my-repo")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// saveSecrets
// ---------------------------------------------------------------------------

describe("saveSecrets", () => {
  it("creates the directory and writes the file", () => {
    saveSecrets("my-repo", { TOKEN: "abc123" });
    expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/my-repo\.json$/),
      JSON.stringify({ TOKEN: "abc123" }, null, 2),
      expect.objectContaining({ encoding: "utf-8", mode: 0o600 })
    );
  });

  it("writes with restricted file permissions (mode 0o600)", () => {
    saveSecrets("my-repo", {});
    const writeArgs = mockWriteFileSync.mock.calls[0];
    expect((writeArgs[2] as { mode: number }).mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// getSecret
// ---------------------------------------------------------------------------

describe("getSecret", () => {
  it("returns null when the key does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getSecret("my-repo", "MISSING_KEY")).toBeNull();
  });

  it("returns the value when the key exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ MY_KEY: "secret-value" }) as unknown as Buffer
    );
    expect(getSecret("my-repo", "MY_KEY")).toBe("secret-value");
  });

  it("returns null when the key is absent from the file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ OTHER_KEY: "x" }) as unknown as Buffer);
    expect(getSecret("my-repo", "MY_KEY")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setSecret
// ---------------------------------------------------------------------------

describe("setSecret", () => {
  it("adds a new key to an empty secrets store", () => {
    mockExistsSync.mockReturnValue(false); // no existing file → loadSecrets returns {}
    setSecret("my-repo", "API_KEY", "super-secret");
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"API_KEY": "super-secret"'),
      expect.any(Object)
    );
  });

  it("merges with existing secrets when updating", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ EXISTING: "old-value" }) as unknown as Buffer
    );
    setSecret("my-repo", "NEW_KEY", "new-value");
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed).toMatchObject({ EXISTING: "old-value", NEW_KEY: "new-value" });
  });
});

// ---------------------------------------------------------------------------
// buildIntegrationEnv
// ---------------------------------------------------------------------------

describe("buildIntegrationEnv", () => {
  it("returns an object with the NODE_ENV=test base value", () => {
    const env = buildIntegrationEnv("my-repo", makeConfig({}), {});
    expect(env["NODE_ENV"]).toBe("test");
  });

  it("includes all expected base env keys", () => {
    const env = buildIntegrationEnv("my-repo", makeConfig({}), {});
    const expectedKeys = [
      "NODE_ENV", "APP_HOST", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URI",
      "JWT_SECRET", "API_KEY", "SESSION_SECRET", "LOG_LEVEL",
      "REDIS_HOST", "REDIS_PORT", "DB_URL",
      "SMTP_HOST", "SMTP_PORT",
      "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY",
    ];
    for (const key of expectedKeys) {
      expect(env).toHaveProperty(key);
    }
  });

  it("resolved secrets override base env values", () => {
    const resolvedSecrets = { DB_URL: "postgres://custom-host/mydb" };
    const env = buildIntegrationEnv("my-repo", makeConfig({}), resolvedSecrets);
    expect(env["DB_URL"]).toBe("postgres://custom-host/mydb");
  });

  it("returns a plain string-to-string record", () => {
    const env = buildIntegrationEnv("my-repo", makeConfig({}), {});
    for (const v of Object.values(env)) {
      expect(typeof v).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveSecrets
// ---------------------------------------------------------------------------

describe("resolveSecrets — docker-postgres service", () => {
  it("builds DB_URL from default postgres env values", async () => {
    mockExistsSync.mockReturnValue(false); // no secrets file
    const config = makeConfig({
      "docker-postgres": {
        type: "database",
        url: "postgresql://localhost/app",
      },
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved["DB_URL"]).toBe("postgresql://postgres:postgres@localhost:5432/app");
  });

  it("builds DB_URL from custom postgres env block", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig({
      "docker-postgres": Object.assign(
        { type: "database" as const, url: "postgresql://localhost/mydb" },
        { env: { POSTGRES_USER: "admin", POSTGRES_PASSWORD: "s3cr3t", POSTGRES_DB: "prod" } }
      ),
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved["DB_URL"]).toBe("postgresql://admin:s3cr3t@localhost:5432/prod");
  });
});

describe("resolveSecrets — docker-redis service", () => {
  it("sets REDIS_HOST to localhost and REDIS_PORT to default 6379", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig({
      "docker-redis": { type: "cache", url: "redis://localhost:6379" },
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved["REDIS_HOST"]).toBe("localhost");
    expect(resolved["REDIS_PORT"]).toBe("6379");
  });
});

describe("resolveSecrets — docker-keycloak service", () => {
  it("builds Keycloak-related env vars with default port 8080", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig({
      "docker-keycloak": { type: "auth", url: "http://localhost:8080" },
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved["KEYCLOAK_URL"]).toBe("http://localhost:8080");
    expect(resolved["AUTH_ISSUER"]).toBe("http://localhost:8080/realms/app");
    expect(resolved["AUTH_JWKS_URI"]).toBe(
      "http://localhost:8080/realms/app/protocol/openid-connect/certs"
    );
  });
});

describe("resolveSecrets — neon service (existing secret)", () => {
  it("uses the cached DB_URL secret without prompting", async () => {
    // First existsSync call (for the secrets file) returns true
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ DB_URL: "postgres://neon-host/db" }) as unknown as Buffer
    );
    const config = makeConfig({
      neon: { type: "database", url: "https://neon.tech/xxx" },
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved["DB_URL"]).toBe("postgres://neon-host/db");
  });
});

describe("resolveSecrets — service type fallbacks", () => {
  it("treats a 'cache' type service as Redis", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig({
      "my-cache": { type: "cache", url: "redis://localhost:6379" },
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved["REDIS_HOST"]).toBe("localhost");
    expect(resolved["REDIS_PORT"]).toBeDefined();
  });

  it("treats an 'auth' type service as Keycloak", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig({
      "my-auth": { type: "auth", url: "http://localhost:8080" },
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved["KEYCLOAK_URL"]).toBeDefined();
    expect(resolved["AUTH_ISSUER"]).toBeDefined();
  });

  it("returns an empty resolved map for unknown service types", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig({
      "my-email": { type: "email", url: "smtp://localhost:1025" },
    });
    const resolved = await resolveSecrets("my-repo", config);
    expect(resolved).toEqual({});
  });
});
