import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { RepoConfig } from "../config.js";
import type { IntegrationConfig } from "./config.js";

export interface ScaffoldResult {
  filesCreated: string[];
  filesSkipped: string[];
}

const JEST_CONFIG_CONTENT = `{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".integration-spec.ts$",
  "transform": {
    "^.+\\\\.(t|j)s$": "ts-jest"
  },
  "moduleNameMapper": {
    "^src/(.*)$": "<rootDir>/src/$1"
  },
  "testTimeout": 30000
}
`;

const TEST_UTILS_MOCK_JWT = `import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { AppModule } from "src/app.module";
import request from "supertest";
import * as jwt from "jsonwebtoken";

let app: INestApplication;
let httpServer: any;

const TEST_JWT_SECRET = process.env.JWT_SECRET || "test-secret-key";

export function getApp(): INestApplication {
  return app;
}

export function getHttpServer(): any {
  return httpServer;
}

export function generateTestToken(payload: Record<string, unknown> = {}): string {
  const defaults = {
    sub: "test-user-id",
    email: "test@example.com",
    realm_access: { roles: ["user"] },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return jwt.sign({ ...defaults, ...payload }, TEST_JWT_SECRET);
}

export async function setupTestApp(): Promise<void> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  await app.init();
  httpServer = app.getHttpServer();
}

export async function teardownTestApp(): Promise<void> {
  if (app) {
    await app.close();
  }
}

export function authRequest(method: "get" | "post" | "put" | "delete", url: string) {
  const token = generateTestToken();
  return (request(httpServer) as any)[method](url).set("Authorization", \`Bearer \${token}\`);
}
`;

const TEST_UTILS_KEYCLOAK = `import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { AppModule } from "src/app.module";
import request from "supertest";

let app: INestApplication;
let httpServer: any;
let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

export function getApp(): INestApplication {
  return app;
}

export function getHttpServer(): any {
  return httpServer;
}

export async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  const tokenUrl = \`\${process.env.AUTH_ISSUER}/protocol/openid-connect/token\`;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: process.env.AUTH_AUDIENCE || "threatzero-api",
      client_secret: process.env.KEYCLOAK_ADMIN_CLIENT_CLIENT_SECRET || "",
      username: process.env.KC_TEST_USERNAME || "",
      password: process.env.KC_TEST_PASSWORD || "",
    }),
  });

  if (!res.ok) {
    throw new Error(\`OIDC token request failed: \${res.status} \${await res.text()}\`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 30) * 1000;
  return cachedAccessToken;
}

export async function setupTestApp(): Promise<void> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  await app.init();
  httpServer = app.getHttpServer();

  // Warm up the token cache
  await getAccessToken();
}

export async function teardownTestApp(): Promise<void> {
  if (app) {
    await app.close();
  }
}

export async function authRequest(method: "get" | "post" | "put" | "delete", url: string) {
  const token = await getAccessToken();
  return (request(httpServer) as any)[method](url).set("Authorization", \`Bearer \${token}\`);
}
`;

const HEALTH_TEST_CONTENT = `import { setupTestApp, teardownTestApp, getHttpServer } from "./test-utils";
import request from "supertest";

describe("Health Check (integration)", () => {
  beforeAll(async () => {
    await setupTestApp();
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  it("/health should return 200", async () => {
    const res = await request(getHttpServer()).get("/health");
    expect(res.status).toBe(200);
  });

  it("/health should include status ok", async () => {
    const res = await request(getHttpServer()).get("/health");
    expect(res.body).toHaveProperty("status", "ok");
  });
});
`;

function getFileSpecs(config: IntegrationConfig): Array<{ relativePath: string; content: string }> {
  const testUtils = config.auth.strategy === "keycloak" ? TEST_UTILS_KEYCLOAK : TEST_UTILS_MOCK_JWT;
  return [
    { relativePath: "test/jest-integration.json", content: JEST_CONFIG_CONTENT },
    { relativePath: "test/integration/test-utils.ts", content: testUtils },
    { relativePath: "test/integration/health.integration-spec.ts", content: HEALTH_TEST_CONTENT },
  ];
}

export function scaffoldIntegrationTests(repo: RepoConfig, config: IntegrationConfig): ScaffoldResult {
  const filesCreated: string[] = [];
  const filesSkipped: string[] = [];

  for (const spec of getFileSpecs(config)) {
    const fullPath = join(repo.localPath, spec.relativePath);

    if (existsSync(fullPath)) {
      filesSkipped.push(spec.relativePath);
      continue;
    }

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, spec.content, "utf-8");
    filesCreated.push(spec.relativePath);
  }

  return { filesCreated, filesSkipped };
}
