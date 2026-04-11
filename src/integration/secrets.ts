import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { IntegrationConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const SECRETS_DIR = join(PROJECT_ROOT, "data", "integration", ".secrets");

export function getSecretsPath(repoName: string): string {
  return join(SECRETS_DIR, `${repoName}.json`);
}

export function loadSecrets(repoName: string): Record<string, string> {
  const filePath = getSecretsPath(repoName);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveSecrets(repoName: string, secrets: Record<string, string>): void {
  const filePath = getSecretsPath(repoName);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(secrets, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function getSecret(repoName: string, key: string): string | null {
  const secrets = loadSecrets(repoName);
  return secrets[key] ?? null;
}

export function setSecret(repoName: string, key: string, value: string): void {
  const secrets = loadSecrets(repoName);
  secrets[key] = value;
  saveSecrets(repoName, secrets);
}

export function promptForSecret(key: string, description: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(`  ${description} [${key}]: `, (answer) => {
      rl.close();
      if (!answer.trim()) {
        reject(new Error(`No value provided for secret "${key}"`));
        return;
      }
      resolve(answer.trim());
    });
  });
}

function toRaw(svc: unknown): Record<string, unknown> {
  return svc as Record<string, unknown>;
}

export async function resolveSecrets(
  repoName: string,
  config: IntegrationConfig
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [name, svc] of Object.entries(config.services)) {
    const svcType = svc.type;

    if (name === "neon" || (svcType === "database" && svc.url?.includes("neon"))) {
      const existing = getSecret(repoName, "DB_URL");
      if (existing) {
        resolved["DB_URL"] = existing;
      } else {
        const value = await promptForSecret("DB_URL", `Neon database connection string for ${repoName}`);
        setSecret(repoName, "DB_URL", value);
        resolved["DB_URL"] = value;
      }
    } else if (name === "docker-redis" || svcType === "cache") {
      resolved["REDIS_HOST"] = "localhost";
      const raw = toRaw(svc);
      const redisPorts = raw["ports"] as Record<string, number> | undefined;
      const redisPort = redisPorts?.[6379] ?? 6379;
      resolved["REDIS_PORT"] = String(redisPort);
    } else if ((name === "docker-postgres" || svcType === "database") && !svc.url?.includes("neon")) {
      const raw = toRaw(svc);
      const env = raw["env"] as Record<string, string> | undefined;
      const pgPorts = raw["ports"] as Record<string, number> | undefined;
      const user = env?.["POSTGRES_USER"] ?? "postgres";
      const password = env?.["POSTGRES_PASSWORD"] ?? "postgres";
      const db = env?.["POSTGRES_DB"] ?? "app";
      const port = pgPorts?.[5432] ?? 5432;
      resolved["DB_URL"] = `postgresql://${user}:${password}@localhost:${port}/${db}`;
    } else if (name === "docker-keycloak" || svcType === "auth") {
      const raw = toRaw(svc);
      const kcPorts = raw["ports"] as Record<string, number> | undefined;
      const port = kcPorts?.[8080] ?? 8080;
      const baseUrl = `http://localhost:${port}`;
      resolved["KEYCLOAK_URL"] = baseUrl;
      resolved["AUTH_ISSUER"] = `${baseUrl}/realms/app`;
      resolved["AUTH_JWKS_URI"] = `${baseUrl}/realms/app/protocol/openid-connect/certs`;
    }
  }

  return resolved;
}

export function buildIntegrationEnv(
  _repoName: string,
  _config: IntegrationConfig,
  resolvedSecrets: Record<string, string>
): Record<string, string> {
  const baseEnv: Record<string, string> = {
    NODE_ENV: "test",
    APP_HOST: "localhost",
    AUTH_ISSUER: "http://localhost:8080/realms/app",
    AUTH_AUDIENCE: "test-client",
    AUTH_JWKS_URI: "http://localhost:8080/realms/app/protocol/openid-connect/certs",
    JWT_SECRET: "test-jwt-secret-for-integration",
    API_KEY: "test-api-key",
    SESSION_SECRET: "test-session-secret",
    LOG_LEVEL: "error",
    REDIS_HOST: "localhost",
    REDIS_PORT: "6379",
    DB_URL: "postgresql://postgres:postgres@localhost:5432/app",
    SMTP_HOST: "localhost",
    SMTP_PORT: "1025",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "minioadmin",
  };

  return { ...baseEnv, ...resolvedSecrets };
}
