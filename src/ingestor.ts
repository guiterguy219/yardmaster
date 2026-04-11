import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { runAgent } from "./agent-runner.js";
import { hashContent, hasFileChanged, upsertContext, ingestPackageJson } from "./context-store.js";
import { getDb } from "./db.js";
import { parseAgentJson } from "./utils/parse-json.js";
import {
  INGESTOR_SYSTEM_PROMPT,
  buildIngestorPrompt,
  type IngestorOutput,
  type IngestorChunk,
} from "./prompts/ingestor.js";
import type { YardmasterConfig } from "./config.js";
import type { ContextKind } from "./context-store.js";

// ---------------------------------------------------------------------------
// Config file discovery
// ---------------------------------------------------------------------------

const CONFIG_FILES = [
  "CLAUDE.md",
  "tsconfig.json",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".prettierrc",
  ".prettierrc.json",
  "biome.json",
  "biome.jsonc",
  ".editorconfig",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".github/CODEOWNERS",
];

/**
 * Discover which config files exist in a repo's base path.
 * Always includes package.json separately (handled by ingestPackageJson).
 */
function discoverFiles(basePath: string): string[] {
  const found: string[] = [];
  for (const file of CONFIG_FILES) {
    if (existsSync(join(basePath, file))) {
      found.push(file);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Haiku chunking
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set<string>(["convention", "snippet", "note", "file"]);
const VALID_ROLES = new Set<string>([
  "coder",
  "style-reviewer",
  "logic-reviewer",
  "planner",
  "tools-agent",
  "test-quality",
  "integration-test",
]);

const TEST_FILE_PATTERNS = [
  /vitest\.config\./,
  /jest\.config\./,
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /setupTests\./,
];

const TEST_KEYWORDS = [
  "test", "spec", "mock", "fixture", "jest", "vitest",
  "supertest", "describe", "it(", "expect(",
];

const ARCHITECTURE_KEYWORDS = [
  "architecture", "module", "structure", "overview", "project layout",
];

const INTEGRATION_KEYWORDS = [
  "error handling", "auth", "authentication", "database",
  "data access", "migration", "repository",
];

/**
 * Enrich chunks with test-quality and integration-test roles based on
 * file name patterns and chunk content/key keywords.
 */
function enrichTestRoles(fileName: string, chunks: IngestorChunk[]): IngestorChunk[] {
  const isTestFile = TEST_FILE_PATTERNS.some((pat) => pat.test(fileName));

  return chunks.map((chunk) => {
    const roles = new Set(chunk.agentRoles);

    if (isTestFile) {
      roles.add("test-quality");
      roles.add("integration-test");
    }

    const searchText = `${chunk.key} ${chunk.content}`.toLowerCase();

    if (TEST_KEYWORDS.some((kw) => searchText.includes(kw))) {
      roles.add("test-quality");
      roles.add("integration-test");
    }

    if (ARCHITECTURE_KEYWORDS.some((kw) => searchText.includes(kw))) {
      roles.add("test-quality");
      roles.add("integration-test");
    }

    if (INTEGRATION_KEYWORDS.some((kw) => searchText.includes(kw))) {
      roles.add("integration-test");
    }

    return { ...chunk, agentRoles: [...roles] };
  });
}

function validateChunk(chunk: IngestorChunk): IngestorChunk | null {
  if (!chunk.key || typeof chunk.key !== "string") return null;
  if (!chunk.content || typeof chunk.content !== "string") return null;

  const kind = VALID_KINDS.has(chunk.kind) ? chunk.kind : "note";
  const agentRoles = Array.isArray(chunk.agentRoles)
    ? chunk.agentRoles.filter((r) => VALID_ROLES.has(r))
    : [];

  return { key: chunk.key, kind: kind as ContextKind, content: chunk.content, agentRoles };
}

/**
 * Call haiku to chunk and tag a file's content.
 * Falls back to storing the whole file as a single chunk on failure.
 */
async function chunkWithHaiku(
  config: YardmasterConfig,
  fileName: string,
  fileContent: string,
  workingDir: string,
): Promise<IngestorChunk[]> {
  const prompt = buildIngestorPrompt(fileName, fileContent);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: INGESTOR_SYSTEM_PROMPT,
    workingDir,
    allowedTools: [],
    model: "haiku",
    timeout: 60_000,
  });

  if (!result.success) {
    console.log(`  Warning: haiku chunking failed for ${fileName}, storing as single chunk`);
    return enrichTestRoles(fileName, [fallbackChunk(fileName, fileContent)]);
  }

  const parsed = parseAgentJson<IngestorOutput>(result.result);
  if (!parsed?.chunks || !Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
    console.log(`  Warning: haiku returned no chunks for ${fileName}, storing as single chunk`);
    return enrichTestRoles(fileName, [fallbackChunk(fileName, fileContent)]);
  }

  const validated: IngestorChunk[] = [];
  for (const raw of parsed.chunks) {
    const chunk = validateChunk(raw);
    if (chunk) validated.push(chunk);
  }

  const chunks = validated.length > 0 ? validated : [fallbackChunk(fileName, fileContent)];
  return enrichTestRoles(fileName, chunks);
}

function fallbackChunk(fileName: string, content: string): IngestorChunk {
  const kind: ContextKind = fileName === "CLAUDE.md" ? "convention" : "file";
  return {
    key: fileName,
    kind,
    content,
    agentRoles: ["coder", "planner"],
  };
}

// ---------------------------------------------------------------------------
// Main ingestor
// ---------------------------------------------------------------------------

export interface IngestResult {
  filesScanned: number;
  filesChanged: number;
  chunksUpserted: number;
  depsUpserted: number;
  errors: string[];
}

/**
 * Ingest local files from a repo: discover config files, use haiku to
 * chunk/tag changed files, and upsert into the context store.
 */
export async function ingestRepo(
  config: YardmasterConfig,
  repo: string,
  basePath: string,
): Promise<IngestResult> {
  const result: IngestResult = {
    filesScanned: 0,
    filesChanged: 0,
    chunksUpserted: 0,
    depsUpserted: 0,
    errors: [],
  };

  // 1. Ingest package.json dependencies (no haiku needed)
  const pkgPath = join(basePath, "package.json");
  if (existsSync(pkgPath)) {
    result.depsUpserted = ingestPackageJson(repo, pkgPath, ["coder", "tools-agent"]);
  }

  // 2. Discover config files
  const files = discoverFiles(basePath);
  result.filesScanned = files.length;

  if (files.length === 0) {
    console.log("  No config files found to ingest.");
    return result;
  }

  // 3. Process each file — check hash, chunk with haiku if changed
  const db = getDb();

  for (const relPath of files) {
    const fullPath = join(basePath, relPath);
    const content = readFileSync(fullPath, "utf-8");

    // Use a composite hash key to track the raw file content.
    // Individual chunks are upserted by their own keys.
    const fileHashKey = `_raw:${relPath}`;
    if (!hasFileChanged(repo, fileHashKey, content)) {
      continue;
    }

    result.filesChanged++;
    console.log(`  Chunking: ${relPath}`);

    try {
      const chunks = await chunkWithHaiku(config, relPath, content, basePath);

      const upsertTx = db.transaction(() => {
        for (const chunk of chunks) {
          upsertContext(repo, chunk.kind, chunk.key, chunk.content, chunk.agentRoles);
          result.chunksUpserted++;
        }

        // Store the raw file hash so we can skip unchanged files next time
        upsertContext(repo, "file", fileHashKey, hashContent(content), []);
      });

      upsertTx();
    } catch (err) {
      const msg = `Failed to ingest ${relPath}: ${(err as Error).message}`;
      console.log(`  Error: ${msg}`);
      result.errors.push(msg);
    }
  }

  return result;
}
