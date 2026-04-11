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

async function resolveSecret(repoName: string, key: string, description: string): Promise<string> {
  const existing = getSecret(repoName, key);
  if (existing) return existing;
  const value = await promptForSecret(key, description);
  setSecret(repoName, key, value);
  return value;
}

export async function resolveSecrets(
  repoName: string,
  config: IntegrationConfig
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [name, svc] of Object.entries(config.services)) {
    switch (svc.type) {
      case "neon": {
        // Neon branches need connection strings — prompt and cache
        const secretKey = name === "keycloak-database" ? "KC_DB_JDBC_URL" : "DB_URL";
        const description = name === "keycloak-database"
          ? `Neon Keycloak database JDBC URL for ${repoName} (jdbc:postgresql://...)`
          : `Neon database connection string for ${repoName} (postgresql://...)`;
        resolved[secretKey] = await resolveSecret(repoName, secretKey, description);
        break;
      }
      case "docker-redis": {
        resolved["REDIS_HOST"] = "localhost";
        const redisPort = svc.ports?.[6379] ?? 6379;
        resolved["REDIS_PORT"] = String(redisPort);
        break;
      }
      case "docker-postgres": {
        const user = svc.env?.["POSTGRES_USER"] ?? "postgres";
        const password = svc.env?.["POSTGRES_PASSWORD"] ?? "postgres";
        const db = svc.env?.["POSTGRES_DB"] ?? "app";
        const port = svc.ports?.[5432] ?? 5432;
        resolved["DB_URL"] = `postgresql://${user}:${password}@localhost:${port}/${db}`;
        break;
      }
      case "docker-keycloak": {
        const port = svc.ports?.[8080] ?? 8080;
        const baseUrl = `http://localhost:${port}`;
        resolved["KEYCLOAK_URL"] = baseUrl;
        break;
      }
    }
  }

  // Auth-specific secrets
  if (config.auth.strategy === "keycloak") {
    const realm = config.auth.realm ?? "threatzero";
    const kcUrl = resolved["KEYCLOAK_URL"] ?? "http://localhost:18080";
    resolved["AUTH_ISSUER"] = `${kcUrl}/realms/${realm}`;
    resolved["AUTH_JWKS_URI"] = `${kcUrl}/realms/${realm}/protocol/openid-connect/certs`;
    resolved["AUTH_AUDIENCE"] = config.auth.clientId ?? "threatzero-api";
    resolved["KEYCLOAK_ADMIN_CLIENT_BASE_URL"] = kcUrl;

    // Prompt for secrets that can't be derived
    resolved["KEYCLOAK_ADMIN_CLIENT_CLIENT_SECRET"] = await resolveSecret(
      repoName, "KC_CLIENT_SECRET", `Keycloak client secret for ${config.auth.clientId ?? "threatzero-api"}`
    );
    resolved["KC_TEST_USERNAME"] = await resolveSecret(repoName, "KC_TEST_USERNAME", "Keycloak test user username");
    resolved["KC_TEST_PASSWORD"] = await resolveSecret(repoName, "KC_TEST_PASSWORD", "Keycloak test user password");

    // Group IDs — these are in the Neon branch KC database
    resolved["KEYCLOAK_PARENT_ORGANIZATIONS_GROUP_ID"] = await resolveSecret(
      repoName, "KC_PARENT_ORGS_GROUP_ID", "Keycloak parent organizations group ID (UUID)"
    );
    resolved["KEYCLOAK_PARENT_AUDIENCES_GROUP_ID"] = await resolveSecret(
      repoName, "KC_PARENT_AUDIENCES_GROUP_ID", "Keycloak parent audiences group ID (UUID)"
    );
    resolved["KEYCLOAK_PARENT_ROLE_GROUPS_GROUP_ID"] = await resolveSecret(
      repoName, "KC_PARENT_ROLE_GROUPS_GROUP_ID", "Keycloak parent role groups group ID (UUID)"
    );
  }

  return resolved;
}

export function buildIntegrationEnv(
  _repoName: string,
  config: IntegrationConfig,
  resolvedSecrets: Record<string, string>
): Record<string, string> {
  const realm = config.auth.realm ?? "threatzero";
  const kcUrl = resolvedSecrets["KEYCLOAK_URL"] ?? "http://localhost:18080";

  // Dummy values for services not under test — required by Zod config validation
  const baseEnv: Record<string, string> = {
    NODE_ENV: "test",
    APP_HOST: "http://localhost:3000",
    API_HOST: "http://localhost:3000",
    // Auth
    AUTH_ISSUER: `${kcUrl}/realms/${realm}`,
    AUTH_AUDIENCE: config.auth.clientId ?? "threatzero-api",
    AUTH_JWKS_URI: `${kcUrl}/realms/${realm}/protocol/openid-connect/certs`,
    // Keycloak admin
    KEYCLOAK_ADMIN_CLIENT_BASE_URL: kcUrl,
    KEYCLOAK_ADMIN_CLIENT_CLIENT_ID: "admin-cli",
    KEYCLOAK_ADMIN_CLIENT_CLIENT_SECRET: "dummy-secret",
    KEYCLOAK_ADMIN_CLIENT_ADMIN_REALM: "master",
    KEYCLOAK_ADMIN_CLIENT_DEFAULT_REALM: realm,
    KEYCLOAK_PARENT_ORGANIZATIONS_GROUP_ID: "00000000-0000-0000-0000-000000000001",
    KEYCLOAK_PARENT_AUDIENCES_GROUP_ID: "00000000-0000-0000-0000-000000000002",
    KEYCLOAK_PARENT_ROLE_GROUPS_GROUP_ID: "00000000-0000-0000-0000-000000000003",
    // Redis
    REDIS_HOST: "localhost",
    REDIS_PORT: "6379",
    REDIS_TLS: "false",
    // Database
    DB_URL: "postgresql://postgres:postgres@localhost:5432/app",
    DB_SSL_ENABLED: "false",
    DB_LOGGING: "false",
    // AWS (not used in integration tests — dummy values)
    AWS_REGION: "us-west-2",
    AWS_S3_BUCKETS_UPLOADED_MEDIA_NAME: "test-bucket",
    AWS_S3_BUCKETS_APPFILES_NAME: "test-appfiles",
    AWS_CLOUDFRONT_DISTRIBUTIONS_APPFILES_DOMAIN: "test.cloudfront.net",
    AWS_CLOUDFRONT_DISTRIBUTIONS_APPFILES_KEYPAIRID: "TESTKEYPAIRID",
    AWS_CLOUDFRONT_DISTRIBUTIONS_APPFILES_PRIVATEKEY: "dummy-private-key",
    // Vimeo (not used)
    VIMEO_ACCESS_TOKEN: "dummy-vimeo-token",
    // Notifications (not used — no real emails!)
    NOTIFICATIONS_SMS_ORIGINATION_PHONE_NUMBER: "+10000000000",
  };

  // Real secrets override dummies
  return { ...baseEnv, ...resolvedSecrets };
}
