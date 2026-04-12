import { execSync, execFileSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { IntegrationConfig, IntegrationServiceConfig } from "./config.js";

export interface DockerComposeResult {
  started: boolean;
  services: string[];
  error?: string;
}

export function getComposeDir(repoName: string): string {
  return join(homedir(), "code", "gibson-ops", "yardmaster", "data", "integration", repoName);
}

export function getComposePath(repoName: string): string {
  return join(getComposeDir(repoName), "docker-compose.yml");
}

export function generateComposeFile(repoName: string, config: IntegrationConfig, resolvedSecrets?: Record<string, string>): string {
  const compose: Record<string, unknown> = {
    version: "3.8",
    services: {} as Record<string, unknown>,
  };

  const services = compose.services as Record<string, unknown>;

  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.type.startsWith("docker-")) continue;

    if (svc.type === "docker-redis") {
      services[name] = buildRedisService(svc);
    } else if (svc.type === "docker-postgres") {
      services[name] = buildPostgresService(svc);
    } else if (svc.type === "docker-keycloak") {
      services[name] = buildKeycloakService(svc, config, resolvedSecrets);
    }
  }

  mkdirSync(getComposeDir(repoName), { recursive: true });
  const yamlStr = yaml.dump(compose);
  writeFileSync(getComposePath(repoName), yamlStr);
  return yamlStr;
}

function mapPorts(ports?: Record<number, number>): string[] | undefined {
  if (!ports) return undefined;
  return Object.entries(ports).map(([container, host]) => `${host}:${container}`);
}

function buildRedisService(svc: IntegrationServiceConfig): Record<string, unknown> {
  const service: Record<string, unknown> = {
    image: svc.image ?? "redis:7-alpine",
  };
  const ports = mapPorts(svc.ports);
  if (ports) service.ports = ports;
  service.healthcheck = {
    test: ["CMD", "redis-cli", "ping"],
    interval: "2s",
    timeout: "3s",
    retries: 5,
  };
  return service;
}

function buildPostgresService(svc: IntegrationServiceConfig): Record<string, unknown> {
  const env = svc.env ?? {};
  const user = env.POSTGRES_USER ?? "test";
  const password = env.POSTGRES_PASSWORD ?? "test";

  const environment: Record<string, string> = {
    ...env,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
  };

  const service: Record<string, unknown> = {
    image: svc.image ?? "postgres:16-alpine",
  };
  const ports = mapPorts(svc.ports);
  if (ports) service.ports = ports;
  service.environment = environment;
  service.healthcheck = {
    test: ["CMD", "pg_isready", "-U", user],
    interval: "2s",
    timeout: "3s",
    retries: 10,
  };
  return service;
}

function parseJdbcUrl(jdbcUrl: string): { dbUrl: string; dbUsername?: string; dbPassword?: string } {
  // jdbc:postgresql://user:pass@host/db?params → jdbc:postgresql://host/db?params + user + pass
  const match = jdbcUrl.match(/^(jdbc:postgresql:\/\/)([^:]+):([^@]+)@(.+)$/);
  if (match) {
    return { dbUrl: `${match[1]}${match[4]}`, dbUsername: match[2], dbPassword: match[3] };
  }
  return { dbUrl: jdbcUrl };
}

function buildKeycloakService(
  svc: IntegrationServiceConfig,
  config: IntegrationConfig,
  resolvedSecrets?: Record<string, string>,
): Record<string, unknown> {
  const kcDbJdbcUrl = resolvedSecrets?.["KC_DB_JDBC_URL"] ?? "";

  // Parse JDBC URL to extract credentials — Keycloak needs them as separate env vars
  // Format: jdbc:postgresql://user:pass@host/db?params
  const { dbUrl, dbUsername, dbPassword } = parseJdbcUrl(kcDbJdbcUrl);

  const environment: Record<string, string> = {
    KC_DB: "postgres",
    KC_DB_URL: dbUrl,
    ...(dbUsername ? { KC_DB_USERNAME: dbUsername } : {}),
    ...(dbPassword ? { KC_DB_PASSWORD: dbPassword } : {}),
    KC_HOSTNAME_STRICT: "false",
    KC_HTTP_ENABLED: "true",
    KC_PROXY_HEADERS: "xforwarded",
    KEYCLOAK_ADMIN: "admin",
    KEYCLOAK_ADMIN_PASSWORD: "admin",
    ...(svc.env ?? {}),
  };

  const service: Record<string, unknown> = {
    image: svc.image,
    environment,
    command: ["start-dev"],
  };

  const ports = mapPorts(svc.ports);
  if (ports) service.ports = ports;

  // Only add depends_on for docker services that exist in the compose file
  if (svc.dependsOn) {
    const dockerDeps: Record<string, { condition: string }> = {};
    for (const dep of svc.dependsOn) {
      const depSvc = config.services[dep];
      if (depSvc?.type.startsWith("docker-")) {
        dockerDeps[dep] = { condition: "service_healthy" };
      }
    }
    if (Object.keys(dockerDeps).length > 0) {
      service.depends_on = dockerDeps;
    }
  }

  service.healthcheck = {
    test: ["CMD-SHELL", "exec 3<>/dev/tcp/localhost/8080"],
    interval: "5s",
    timeout: "5s",
    retries: 30,
    start_period: "30s",
  };

  return service;
}

export function startServices(repoName: string, config: IntegrationConfig, resolvedSecrets?: Record<string, string>): DockerComposeResult {
  const dockerServices = Object.entries(config.services)
    .filter(([, svc]) => svc.type.startsWith("docker-"));

  const serviceNames = dockerServices.map(([name]) => name);

  if (serviceNames.length === 0) {
    return { started: false, services: [], error: undefined };
  }

  try {
    generateComposeFile(repoName, config, resolvedSecrets);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return { started: false, services: serviceNames, error: message };
  }

  const filePath = getComposePath(repoName);

  try {
    execFileSync("docker", ["compose", "-f", filePath, "up", "-d", "--wait"], {
      timeout: 120_000,
      stdio: "pipe",
    });
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string };
    const stderr = err.stderr ? String(err.stderr) : "Unknown error";
    return { started: false, services: serviceNames, error: stderr };
  }

  return { started: true, services: serviceNames };
}

export function stopServices(repoName: string): void {
  const composePath = getComposePath(repoName);
  if (!existsSync(composePath)) return;

  try {
    execFileSync("docker", ["compose", "-f", composePath, "down", "-v"], {
      timeout: 60_000,
      stdio: "pipe",
    });
  } catch (e: unknown) {
    console.warn(`Warning: failed to stop services for ${repoName}:`, e);
  }
}

export function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
