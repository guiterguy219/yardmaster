/**
 * Integration tests for src/integration/docker.ts
 *
 * These tests exercise generateComposeFile() end-to-end: they call the real
 * function (which writes YAML to disk), parse the output, and assert on the
 * Docker Compose structure produced for each service type.
 *
 * Focus areas driven by recent changes to buildKeycloakService:
 *  - svc.env is passed through directly (JDBC URL parsing removed)
 *  - depends_on is always hardcoded to { postgres: { condition: "service_healthy" } }
 *  - healthcheck uses curl instead of the old TCP socket probe
 *  - resolvedSecrets are no longer consulted for KC_DB_* vars
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { generateComposeFile, getComposePath, getComposeDir } from "../integration/docker.js";
import type { IntegrationConfig } from "../integration/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_REPO = "ym-docker-test-" + process.pid;

function readCompose(repoName: string): Record<string, unknown> {
  const raw = require("node:fs").readFileSync(getComposePath(repoName), "utf-8");
  return yaml.load(raw) as Record<string, unknown>;
}

function composeSvc(repoName: string, svcName: string): Record<string, unknown> {
  const compose = readCompose(repoName);
  const services = compose.services as Record<string, unknown>;
  return services[svcName] as Record<string, unknown>;
}

function cleanupTestRepo(repoName: string): void {
  const composePath = getComposePath(repoName);
  if (existsSync(composePath)) unlinkSync(composePath);
  const dir = getComposeDir(repoName);
  if (existsSync(dir)) {
    try { rmdirSync(dir); } catch { /* ignore if not empty */ }
  }
}

// ---------------------------------------------------------------------------
// Keycloak service generation
// ---------------------------------------------------------------------------

describe("generateComposeFile — docker-keycloak", () => {
  afterEach(() => cleanupTestRepo(TEST_REPO));

  it("sets depends_on to postgres with service_healthy regardless of config.dependsOn", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    expect(svc.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
    });
  });

  it("uses curl-based healthcheck, not TCP socket probe", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    const healthcheck = svc.healthcheck as Record<string, unknown>;
    const test = healthcheck.test as string[];

    expect(test).toContain("curl -fsS http://localhost:8080/health || exit 1");
    // Must NOT use the old TCP socket probe
    expect(JSON.stringify(test)).not.toContain("/dev/tcp");
  });

  it("passes svc.env through directly without injecting KC_DB_* credentials", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
          env: {
            KEYCLOAK_ADMIN: "admin",
            KEYCLOAK_ADMIN_PASSWORD: "admin",
            KC_HOSTNAME_STRICT: "false",
          },
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    const environment = svc.environment as Record<string, string>;

    expect(environment["KEYCLOAK_ADMIN"]).toBe("admin");
    expect(environment["KC_HOSTNAME_STRICT"]).toBe("false");

    // JDBC-derived keys must NOT be injected automatically
    expect(environment).not.toHaveProperty("KC_DB_URL");
    expect(environment).not.toHaveProperty("KC_DB_USERNAME");
    expect(environment).not.toHaveProperty("KC_DB_PASSWORD");
    expect(environment).not.toHaveProperty("KC_DB");
  });

  it("omits the environment key entirely when svc.env is empty or absent", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
          // no env
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    expect(svc).not.toHaveProperty("environment");
  });

  it("does not apply resolvedSecrets (KC_DB_JDBC_URL) to the Keycloak service", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
        },
      },
    };

    // Pass a resolved secret that the old code used to parse for DB credentials
    const resolvedSecrets = {
      KC_DB_JDBC_URL: "jdbc:postgresql://dbuser:dbpass@localhost/mydb",
    };

    generateComposeFile(TEST_REPO, config, resolvedSecrets);

    const svc = composeSvc(TEST_REPO, "keycloak");
    // No environment block at all — secrets must not be injected
    expect(svc).not.toHaveProperty("environment");
  });

  it("maps ports correctly when svc.ports is configured", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
          ports: { 8080: 18080 },
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    expect(svc.ports).toEqual(["18080:8080"]);
  });

  it("uses start-dev command", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    expect(svc.command).toEqual(["start-dev"]);
  });
});

// ---------------------------------------------------------------------------
// Multi-service compose — Keycloak alongside Postgres and Redis
// ---------------------------------------------------------------------------

describe("generateComposeFile — multi-service with keycloak", () => {
  afterEach(() => cleanupTestRepo(TEST_REPO));

  it("generates valid compose file containing all three service types", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        postgres: {
          type: "docker-postgres",
          image: "postgres:16-alpine",
          ports: { 5432: 5432 },
          env: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "secret" },
        },
        redis: {
          type: "docker-redis",
          ports: { 6379: 16379 },
        },
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
          ports: { 8080: 18080 },
          env: {
            KEYCLOAK_ADMIN: "admin",
            KEYCLOAK_ADMIN_PASSWORD: "admin",
          },
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const compose = readCompose(TEST_REPO);
    const services = compose.services as Record<string, unknown>;

    expect(Object.keys(services)).toContain("postgres");
    expect(Object.keys(services)).toContain("redis");
    expect(Object.keys(services)).toContain("keycloak");

    // Keycloak always depends on postgres (hardcoded)
    const kc = services.keycloak as Record<string, unknown>;
    expect(kc.depends_on).toEqual({ postgres: { condition: "service_healthy" } });

    // Postgres has its own healthcheck via pg_isready
    const pg = services.postgres as Record<string, unknown>;
    const pgHc = pg.healthcheck as Record<string, unknown>;
    const pgTest = pgHc.test as string[];
    expect(pgTest).toContain("pg_isready");

    // Redis has its own healthcheck via redis-cli ping
    const rd = services.redis as Record<string, unknown>;
    const rdHc = rd.healthcheck as Record<string, unknown>;
    const rdTest = rdHc.test as string[];
    expect(rdTest).toContain("redis-cli");
  });
});
