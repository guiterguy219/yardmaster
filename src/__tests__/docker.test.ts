/**
 * Integration tests for src/integration/docker.ts
 *
 * These tests exercise generateComposeFile() end-to-end: they call the real
 * function (which writes YAML to disk), parse the output, and assert on the
 * Docker Compose structure produced for each service type.
 *
 * Focus areas:
 *  - Keycloak gets KC_DB_* env vars from resolvedSecrets (JDBC URL parsing)
 *  - depends_on only includes docker services listed in svc.dependsOn
 *  - healthcheck uses TCP socket probe on port 8080
 *  - KC defaults (admin user, hostname settings) always present
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

  it("only adds depends_on for docker services in svc.dependsOn", () => {
    const config: IntegrationConfig = {
      enabled: true,
      testCommand: "npm test",
      testTimeout: 60_000,
      auth: { strategy: "keycloak" },
      services: {
        postgres: { type: "docker-postgres", image: "postgres:16-alpine" },
        keycloak: {
          type: "docker-keycloak",
          image: "quay.io/keycloak/keycloak:24",
          dependsOn: ["postgres"],
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    expect(svc.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
    });
  });

  it("omits depends_on when no dependsOn is configured", () => {
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
    expect(svc).not.toHaveProperty("depends_on");
  });

  it("uses TCP socket healthcheck on port 8080", () => {
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

    expect(test).toContain("exec 3<>/dev/tcp/localhost/8080");
  });

  it("sets KC default env vars and merges with svc.env", () => {
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
            KC_HOSTNAME_STRICT: "false",
          },
        },
      },
    };

    generateComposeFile(TEST_REPO, config);

    const svc = composeSvc(TEST_REPO, "keycloak");
    const environment = svc.environment as Record<string, string>;

    // KC defaults
    expect(environment["KC_DB"]).toBe("postgres");
    expect(environment["KEYCLOAK_ADMIN"]).toBe("admin");
    expect(environment["KEYCLOAK_ADMIN_PASSWORD"]).toBe("admin");
    // svc.env merged
    expect(environment["KC_HOSTNAME_STRICT"]).toBe("false");
  });

  it("always sets KC default environment even without svc.env", () => {
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
    const environment = svc.environment as Record<string, string>;
    expect(environment["KC_DB"]).toBe("postgres");
    expect(environment["KEYCLOAK_ADMIN"]).toBe("admin");
  });

  it("parses resolvedSecrets KC_DB_JDBC_URL into KC_DB_URL/USERNAME/PASSWORD", () => {
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

    const resolvedSecrets = {
      KC_DB_JDBC_URL: "jdbc:postgresql://dbuser:dbpass@localhost/mydb",
    };

    generateComposeFile(TEST_REPO, config, resolvedSecrets);

    const svc = composeSvc(TEST_REPO, "keycloak");
    const environment = svc.environment as Record<string, string>;
    expect(environment["KC_DB_URL"]).toBe("jdbc:postgresql://localhost/mydb");
    expect(environment["KC_DB_USERNAME"]).toBe("dbuser");
    expect(environment["KC_DB_PASSWORD"]).toBe("dbpass");
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
          dependsOn: ["postgres"],
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

    // Keycloak depends on postgres (via dependsOn config)
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
