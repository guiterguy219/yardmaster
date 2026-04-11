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
    "^.+\\\\.ts$": "ts-jest"
  },
  "moduleNameMapper": {
    "^src/(.*)$": "<rootDir>/src/$1"
  },
  "setupFilesAfterSetup": ["./integration/test-utils.ts"],
  "testTimeout": 30000
}
`;

const TEST_UTILS_CONTENT = `import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { AppModule } from "src/app.module";
import * as request from "supertest";
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

const HEALTH_TEST_CONTENT = `import { setupTestApp, teardownTestApp, getHttpServer } from "./test-utils";
import * as request from "supertest";

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

const FILE_SPECS: Array<{ relativePath: string; content: string }> = [
  { relativePath: "test/jest-integration.json", content: JEST_CONFIG_CONTENT },
  { relativePath: "test/integration/test-utils.ts", content: TEST_UTILS_CONTENT },
  { relativePath: "test/integration/health.integration-spec.ts", content: HEALTH_TEST_CONTENT },
];

export function scaffoldIntegrationTests(repo: RepoConfig, _config: IntegrationConfig): ScaffoldResult {
  const filesCreated: string[] = [];
  const filesSkipped: string[] = [];

  for (const spec of FILE_SPECS) {
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
