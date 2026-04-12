import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { ghExecEnv } from "../gh-auth.js";

const TZ_KEYCLOAK_REPO = "threatzero-solutions/tz-keycloak";
const DEFAULT_CLONE_PATH = resolve(homedir(), "code", "threatzero", "tz-keycloak");
const IMAGE_NAME = "tz-keycloak";
const IMAGE_TAG = "local";

export function isKeycloakImageBuilt(): boolean {
  try {
    execSync(`docker image inspect ${IMAGE_NAME}:${IMAGE_TAG}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function cloneKeycloakRepo(clonePath?: string): string {
  const path = clonePath ?? DEFAULT_CLONE_PATH;
  if (existsSync(path)) {
    console.log("tz-keycloak repo already cloned");
    return path;
  }
  execSync(`gh repo clone ${TZ_KEYCLOAK_REPO} "${path}"`, { stdio: "pipe", env: ghExecEnv("threatzero-solutions") });
  return path;
}

export function buildKeycloakImage(repoPath?: string): { success: boolean; error?: string } {
  const clonePath = cloneKeycloakRepo(repoPath);
  try {
    execSync(`docker build -t ${IMAGE_NAME}:${IMAGE_TAG} .`, {
      cwd: clonePath,
      stdio: "pipe",
      timeout: 300_000,
    });
    return { success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return { success: false, error: message };
  }
}

export function ensureKeycloakImage(clonePath?: string): { ready: boolean; error?: string } {
  if (isKeycloakImageBuilt()) {
    return { ready: true };
  }
  const result = buildKeycloakImage(clonePath);
  return { ready: result.success, error: result.error };
}

export function getKeycloakComposeService(kcDbJdbcUrl: string, hostPort: number = 18080): Record<string, unknown> {
  // Parse JDBC URL to extract credentials — Keycloak needs them as separate env vars
  const match = kcDbJdbcUrl.match(/^(jdbc:postgresql:\/\/)([^:]+):([^@]+)@(.+)$/);
  const dbUrl = match ? `${match[1]}${match[4]}` : kcDbJdbcUrl;
  const dbUsername = match?.[2];
  const dbPassword = match?.[3];

  return {
    image: `${IMAGE_NAME}:${IMAGE_TAG}`,
    ports: [`${hostPort}:8080`],
    environment: {
      KC_DB: "postgres",
      KC_DB_URL: dbUrl,
      ...(dbUsername ? { KC_DB_USERNAME: dbUsername } : {}),
      ...(dbPassword ? { KC_DB_PASSWORD: dbPassword } : {}),
      KC_HOSTNAME_STRICT: "false",
      KC_HTTP_ENABLED: "true",
      KC_PROXY_HEADERS: "xforwarded",
      KEYCLOAK_ADMIN: "admin",
      KEYCLOAK_ADMIN_PASSWORD: "admin",
    },
    healthcheck: {
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/localhost/8080"],
      interval: "5s",
      timeout: "5s",
      retries: 30,
      start_period: "30s",
    },
    command: ["start-dev"],
  };
}
