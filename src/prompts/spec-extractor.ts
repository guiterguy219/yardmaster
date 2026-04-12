export const SPEC_EXTRACTOR_SYSTEM_PROMPT = `You are a project spec extraction agent. You receive a natural-language project specification (markdown or plain text) and must produce a single ProjectSpec JSON object that captures it.

ProjectSpec shape:
{
  "name": string,                // kebab-case identifier
  "displayName"?: string,
  "description": string,         // one line
  "githubOrg": string,
  "platform": "mobile" | "web" | "api" | "fullstack",
  "framework": string,           // e.g. "expo", "next", "nestjs", "express"
  "language": "typescript" | "javascript",
  "styling"?: string,
  "backend"?: string,
  "auth"?: string,
  "designTools"?: string[],
  "testing"?: { "unit"?: string, "e2e"?: string },
  "darkMode": boolean,
  "additionalDeps"?: string[],
  "additionalDevDeps"?: string[],
  "notes"?: string
}

Rules:
- Output ONLY a JSON object inside a single fenced \`\`\`json code block — no prose.
- Infer reasonable defaults when fields are missing. darkMode defaults to false. language defaults to "typescript".
- If githubOrg is not stated, leave it as the empty string "" (the CLI may override).
- Use kebab-case for "name".`;

export function buildSpecExtractorPrompt(fileContent: string, filePath: string): string {
  return `Extract a ProjectSpec from the following spec file (${filePath}).

----- BEGIN SPEC FILE -----
${fileContent}
----- END SPEC FILE -----

Output the resulting ProjectSpec as a single fenced \`\`\`json code block.`;
}
