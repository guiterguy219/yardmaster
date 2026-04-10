import { runAgent } from "../agent-runner.js";
import { hasFileChanged, upsertContext } from "../context-store.js";
import { getDb } from "../db.js";
import { parseAgentJson } from "../utils/parse-json.js";
import {
  DOCS_INGESTOR_SYSTEM_PROMPT,
  DOCS_FETCHER_SYSTEM_PROMPT,
  DOCS_SEARCH_SYSTEM_PROMPT,
  buildDocsFetcherPrompt,
  buildDocsIngestorPrompt,
  buildDocsSearchPrompt,
  type DocsIngestorOutput,
  type DocsSearchOutput,
  type DocsChunk,
} from "../prompts/docs-ingestor.js";
import type { YardmasterConfig } from "../config.js";
import type { ContextKind } from "../context-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocsIngestResult {
  urlsProcessed: number;
  urlsChanged: number;
  chunksUpserted: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Validation (mirrors ingestor.ts pattern)
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set<string>(["convention", "snippet", "note", "file"]);
const VALID_ROLES = new Set<string>([
  "coder",
  "style-reviewer",
  "logic-reviewer",
  "planner",
  "tools-agent",
]);

function validateChunk(chunk: DocsChunk): DocsChunk | null {
  if (!chunk.key || typeof chunk.key !== "string") return null;
  if (!chunk.content || typeof chunk.content !== "string") return null;

  const kind = VALID_KINDS.has(chunk.kind) ? chunk.kind : "note";
  const agentRoles = Array.isArray(chunk.agentRoles)
    ? chunk.agentRoles.filter((r) => VALID_ROLES.has(r))
    : [];

  return {
    key: chunk.key,
    kind: kind as ContextKind,
    content: chunk.content,
    agentRoles,
  };
}

// ---------------------------------------------------------------------------
// Web fetching via Claude CLI agent with web tools
// ---------------------------------------------------------------------------

/**
 * Fetch a URL's content by running a haiku agent with web tools.
 * Returns the page text or null on failure.
 */
async function fetchDocPage(
  config: YardmasterConfig,
  url: string,
  workingDir: string,
): Promise<string | null> {
  const result = await runAgent(config, {
    prompt: buildDocsFetcherPrompt(url),
    systemPrompt: DOCS_FETCHER_SYSTEM_PROMPT,
    workingDir,
    allowedTools: [
      "WebFetch",
      "mcp__claude_ai_Parallel_Search_MCP__web_fetch",
    ],
    model: "haiku",
    timeout: 30_000,
  });

  if (!result.success || !result.result || result.result.includes("FETCH_FAILED")) {
    return null;
  }

  return result.result;
}

// ---------------------------------------------------------------------------
// Chunking via haiku
// ---------------------------------------------------------------------------

/**
 * Send fetched page content to haiku for chunking and tagging.
 * Falls back to a single note chunk on failure.
 */
async function chunkDocsWithHaiku(
  config: YardmasterConfig,
  url: string,
  pageContent: string,
  libraryName: string,
  workingDir: string,
): Promise<DocsChunk[]> {
  // Truncate very long pages to avoid blowing the context window
  const maxChars = 30_000;
  const truncated =
    pageContent.length > maxChars
      ? pageContent.slice(0, maxChars) + "\n\n[... truncated]"
      : pageContent;

  const prompt = buildDocsIngestorPrompt(url, truncated, libraryName);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: DOCS_INGESTOR_SYSTEM_PROMPT,
    workingDir,
    allowedTools: [],
    model: "haiku",
    timeout: 60_000,
  });

  if (!result.success) {
    console.log(`  Warning: haiku chunking failed for ${url}, storing as single chunk`);
    return [fallbackChunk(url, truncated, libraryName)];
  }

  const parsed = parseAgentJson<DocsIngestorOutput>(result.result);
  if (!parsed?.chunks || !Array.isArray(parsed.chunks)) {
    console.log(`  Warning: haiku returned no chunks for ${url}, storing as single chunk`);
    return [fallbackChunk(url, truncated, libraryName)];
  }

  // Empty chunks array means the page had no useful content
  if (parsed.chunks.length === 0) {
    console.log(`  Skipping ${url} — no useful documentation content`);
    return [];
  }

  const validated: DocsChunk[] = [];
  for (const raw of parsed.chunks) {
    const chunk = validateChunk(raw);
    if (chunk) validated.push(chunk);
  }

  return validated.length > 0 ? validated : [fallbackChunk(url, truncated, libraryName)];
}

function fallbackChunk(url: string, content: string, libraryName: string): DocsChunk {
  let urlSlug: string;
  try {
    urlSlug = new URL(url).pathname.replace(/\//g, "-").replace(/^-|-$/g, "");
  } catch {
    urlSlug = url.replace(/[^a-zA-Z0-9]/g, "-");
  }

  return {
    key: `docs:${libraryName}:${urlSlug}`,
    kind: "note",
    content: content.slice(0, 4000),
    agentRoles: ["coder", "planner"],
  };
}

// ---------------------------------------------------------------------------
// Web search for doc URLs
// ---------------------------------------------------------------------------

/**
 * Search the web for documentation URLs matching a query.
 * Uses a haiku agent with web search tools. Returns URLs or empty array on failure.
 */
export async function searchDocsUrls(
  config: YardmasterConfig,
  query: string,
  libraryName: string,
  workingDir: string,
): Promise<string[]> {
  const result = await runAgent(config, {
    prompt: buildDocsSearchPrompt(query, libraryName),
    systemPrompt: DOCS_SEARCH_SYSTEM_PROMPT,
    workingDir,
    allowedTools: [
      "WebSearch",
      "mcp__claude_ai_Parallel_Search_MCP__web_search_preview",
    ],
    model: "haiku",
    timeout: 30_000,
  });

  if (!result.success || !result.result) {
    return [];
  }

  const parsed = parseAgentJson<DocsSearchOutput>(result.result);
  if (!parsed?.urls || !Array.isArray(parsed.urls)) {
    return [];
  }

  // Filter to valid URLs only
  return parsed.urls.filter((url) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Main docs ingester
// ---------------------------------------------------------------------------

/**
 * Ingest web documentation pages: fetch each URL, chunk with haiku,
 * and upsert into the context store. Skips URLs whose content hasn't
 * changed since last ingestion.
 */
export async function ingestDocs(
  config: YardmasterConfig,
  repo: string,
  libraryName: string,
  urls: string[],
  workingDir: string,
): Promise<DocsIngestResult> {
  const result: DocsIngestResult = {
    urlsProcessed: 0,
    urlsChanged: 0,
    chunksUpserted: 0,
    errors: [],
  };

  const db = getDb();

  for (const url of urls) {
    result.urlsProcessed++;
    console.log(`  Fetching: ${url}`);

    try {
      const pageContent = await fetchDocPage(config, url, workingDir);

      if (!pageContent) {
        const msg = `Failed to fetch ${url}`;
        console.log(`  Warning: ${msg}`);
        result.errors.push(msg);
        continue;
      }

      // Check if content changed since last ingestion
      const contentHashKey = `_raw:docs:${libraryName}:${url}`;
      if (!hasFileChanged(repo, contentHashKey, pageContent)) {
        console.log(`  Unchanged: ${url}`);
        continue;
      }

      result.urlsChanged++;
      console.log(`  Chunking: ${url}`);

      const chunks = await chunkDocsWithHaiku(config, url, pageContent, libraryName, workingDir);

      if (chunks.length === 0) continue;

      const upsertTx = db.transaction(() => {
        for (const chunk of chunks) {
          upsertContext(repo, chunk.kind, chunk.key, chunk.content, chunk.agentRoles);
          result.chunksUpserted++;
        }

        // Store raw content so hasFileChanged can detect changes next time
        upsertContext(repo, "file", contentHashKey, pageContent, []);
      });

      upsertTx();
    } catch (err) {
      const msg = `Failed to ingest ${url}: ${(err as Error).message}`;
      console.log(`  Error: ${msg}`);
      result.errors.push(msg);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Maintenance: prune stale doc entries
// ---------------------------------------------------------------------------

/**
 * Delete doc context entries for a repo that haven't been updated in
 * the given number of days.
 */
export function pruneStaleDocEntries(repo: string, olderThanDays: number): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM context_entries
       WHERE repo = ? AND key LIKE 'docs:%' AND updated_at < datetime('now', ?)`,
    )
    .run(repo, `-${olderThanDays} days`);

  return result.changes;
}
