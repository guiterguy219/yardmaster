import type { ContextKind } from "../context-store.js";

export const INGESTOR_SYSTEM_PROMPT = `You are a context chunker for a coding agent system. Your job is to break project files into semantic chunks and tag each chunk with the agent roles that would benefit from it.

Available context kinds:
- "convention" — coding standards, naming patterns, architectural rules, workflow instructions
- "snippet" — important code patterns, reusable examples, key interfaces/types
- "note" — project metadata, build info, deployment notes, miscellaneous context
- "file" — raw file content that doesn't fit other categories (use sparingly)
- "dependency" — dependency info (already handled separately, don't output this kind)

Available agent roles:
- "coder" — writes code, needs conventions, patterns, and architecture info
- "style-reviewer" — checks naming, formatting, imports; needs style conventions
- "logic-reviewer" — checks correctness, error handling, security; needs architecture and patterns
- "planner" — decomposes tasks; needs architecture overview and project structure
- "tools-agent" — recommends libraries; needs dependency and tooling info

Rules:
- Break large files into logical sections (e.g., separate sections of a CLAUDE.md)
- Small config files can be a single chunk
- Each chunk should be self-contained and meaningful on its own
- Assign agent_roles based on who would actually use that information
- Use descriptive keys like "CLAUDE.md:architecture" or "tsconfig:compiler-options"
- Keep chunks concise — omit boilerplate, focus on actionable information
- Return ONLY valid JSON, no markdown fencing`;

export interface IngestorChunk {
  key: string;
  kind: ContextKind;
  content: string;
  agentRoles: string[];
}

export interface IngestorOutput {
  chunks: IngestorChunk[];
}

export function buildIngestorPrompt(
  fileName: string,
  fileContent: string,
): string {
  return `## File

Name: ${fileName}

\`\`\`
${fileContent}
\`\`\`

## Instructions

Break this file into semantic chunks for a coding agent context store. For each chunk, provide:
- "key": a descriptive identifier like "${fileName}:<section-name>"
- "kind": one of "convention", "snippet", "note", "file"
- "content": the meaningful content for that chunk (can be summarized or extracted)
- "agentRoles": array of roles that need this info: "coder", "style-reviewer", "logic-reviewer", "planner", "tools-agent"

Return JSON: { "chunks": [ { "key", "kind", "content", "agentRoles" }, ... ] }`;
}
