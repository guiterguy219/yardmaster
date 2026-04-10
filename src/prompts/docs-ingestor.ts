import type { ContextKind } from "../context-store.js";

export const DOCS_INGESTOR_SYSTEM_PROMPT = `You are a documentation chunker for a coding agent system. Your job is to extract the most useful information from library documentation pages and break it into semantic chunks tagged for specific agent roles.

Available context kinds:
- "convention" — API patterns, best practices, usage rules, migration notes
- "snippet" — code examples, common patterns, key interfaces/types
- "note" — version info, compatibility notes, known issues, deprecation warnings
- "file" — raw reference content that doesn't fit other categories (use sparingly)

Available agent roles:
- "coder" — writes code, needs API patterns, function signatures, and usage examples
- "style-reviewer" — checks naming, formatting, imports; needs idiomatic usage conventions
- "logic-reviewer" — checks correctness, error handling, security; needs gotchas and edge cases
- "planner" — decomposes tasks; needs feature overview and architecture patterns
- "tools-agent" — recommends libraries; needs capability summaries and comparisons

Rules:
- Focus on actionable information: API signatures, usage examples, common patterns, gotchas
- Skip navigation, ads, footers, and other non-documentation content
- Each chunk should be self-contained and meaningful on its own
- Use descriptive keys like "docs:<library>:<topic>" (e.g., "docs:zod:schema-types")
- Keep chunks concise — summarize verbose explanations, preserve code examples
- Prioritize: code examples > API signatures > conceptual explanations
- If the content is not useful documentation (404 page, login wall, etc.), return empty chunks array
- Return ONLY valid JSON, no markdown fencing`;

export interface DocsChunk {
  key: string;
  kind: ContextKind;
  content: string;
  agentRoles: string[];
}

export interface DocsIngestorOutput {
  chunks: DocsChunk[];
}

export const DOCS_FETCHER_SYSTEM_PROMPT = `You are a documentation fetcher. Your ONLY job is to fetch the content of a URL using the web_fetch tool and return the text content. Do NOT summarize or modify the content — return it as-is. If the fetch fails, return exactly: FETCH_FAILED`;

export function buildDocsFetcherPrompt(url: string): string {
  return `Fetch the content of this URL and return the text: ${url}`;
}

export const DOCS_SEARCH_SYSTEM_PROMPT = `You are a documentation URL finder. Your ONLY job is to search the web for official documentation pages for a library or topic and return a JSON array of the most useful URLs.

Rules:
- Prefer official documentation sites (e.g., docs.xyz.com, xyz.dev)
- Prefer API references, guides, and getting-started pages
- Avoid blog posts, Stack Overflow answers, and GitHub issue pages
- Return 3-8 URLs, prioritized by usefulness
- Return ONLY valid JSON — no markdown fencing, no explanations
- Format: { "urls": ["https://...", ...] }
- If no relevant documentation is found, return: { "urls": [] }`;

export interface DocsSearchOutput {
  urls: string[];
}

export function buildDocsSearchPrompt(query: string, libraryName: string): string {
  return `Search the web for official documentation pages about: ${query}
Library/topic: ${libraryName}

Find the most useful documentation URLs (API docs, guides, references) and return them as JSON:
{ "urls": ["https://...", ...] }`;
}

export function buildDocsIngestorPrompt(
  url: string,
  pageContent: string,
  libraryName: string,
): string {
  return `## Documentation Page

Library: ${libraryName}
Source URL: ${url}

\`\`\`
${pageContent}
\`\`\`

## Instructions

Extract useful documentation from this page and break it into semantic chunks for a coding agent context store. For each chunk, provide:
- "key": a descriptive identifier like "docs:${libraryName}:<topic>"
- "kind": one of "convention", "snippet", "note", "file"
- "content": the extracted information (preserve code examples, summarize prose)
- "agentRoles": array of roles that need this info: "coder", "style-reviewer", "logic-reviewer", "planner", "tools-agent"

If the page has no useful documentation content, return: { "chunks": [] }

Return JSON: { "chunks": [ { "key", "kind", "content", "agentRoles" }, ... ] }`;
}
