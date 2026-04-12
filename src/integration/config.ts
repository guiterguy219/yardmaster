import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export type ServiceType = "neon" | "docker-postgres" | "docker-redis" | "docker-keycloak";

export type AuthStrategy = "keycloak" | "mock-jwt";

export interface IntegrationServiceConfig {
  type: ServiceType;
  image?: string;
  ports?: Record<number, number>;  // containerPort -> hostPort
  env?: Record<string, string>;
  dependsOn?: string[];
  build?: {
    repo: string;
    clonePath: string;
  };
}

export interface IntegrationAuthConfig {
  strategy: AuthStrategy;
  realm?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface IntegrationConfig {
  enabled: boolean;
  services: Record<string, IntegrationServiceConfig>;
  auth: IntegrationAuthConfig;
  testCommand: string;
  testTimeout: number;
}

const INTEGRATION_DIR = join(homedir(), "code", "gibson-ops", "yardmaster", "data", "integration");

function configPath(repoName: string): string {
  return join(INTEGRATION_DIR, `${repoName}.yml`);
}

export function integrationConfigPath(repoName: string): string {
  return configPath(repoName);
}

export function hasIntegrationConfig(repoName: string): boolean {
  return existsSync(configPath(repoName));
}

export function loadIntegrationConfig(repoName: string): IntegrationConfig | null {
  const path = configPath(repoName);
  if (!existsSync(path)) {
    return null;
  }

  const raw = yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>;

  if (typeof raw.enabled !== "boolean") {
    throw new Error(`Invalid integration config for ${repoName}: 'enabled' must be a boolean`);
  }
  if (typeof raw.services !== "object" || raw.services === null || Array.isArray(raw.services)) {
    throw new Error(`Invalid integration config for ${repoName}: 'services' must be an object`);
  }
  if (typeof raw.testCommand !== "string") {
    throw new Error(`Invalid integration config for ${repoName}: 'testCommand' must be a string`);
  }

  const authRaw = (raw.auth ?? {}) as Record<string, unknown>;

  return {
    enabled: raw.enabled,
    services: raw.services as Record<string, IntegrationServiceConfig>,
    auth: {
      strategy: (authRaw.strategy as AuthStrategy) ?? "mock-jwt",
      realm: authRaw.realm as string | undefined,
      clientId: authRaw.clientId as string | undefined,
      clientSecret: authRaw.clientSecret as string | undefined,
    },
    testCommand: raw.testCommand,
    testTimeout: typeof raw.testTimeout === "number" ? raw.testTimeout : 600_000,
  };
}
