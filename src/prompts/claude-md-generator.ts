import type { ProjectSpec } from "../new-project/types.js";

export const CLAUDE_MD_GENERATOR_SYSTEM_PROMPT = `You are a CLAUDE.md generator. Given a ProjectSpec for a freshly scaffolded project, produce a high-quality CLAUDE.md that orients an AI coding agent (Claude Code) to the project.

The CLAUDE.md should cover:
- A one-paragraph project overview
- The stack (framework, language, styling, backend, auth)
- Standard commands (dev, build, test, lint, typecheck) inferred from the framework
- Key directories and file patterns for this framework
- Conventions (TypeScript strict, ESM, etc. as applicable)
- Any design tool instructions (e.g. for "impeccable": instruct the agent to run /impeccable teach first and use Impeccable for all design decisions)
- Notes from the spec, if any

Rules:
- Output ONLY the CLAUDE.md markdown content. No JSON, no fences around the entire document, no preamble.
- Be specific to the chosen framework — do not output generic placeholders.
- Keep it focused and actionable; avoid filler.`;

export function buildClaudeMdGeneratorPrompt(spec: ProjectSpec): string {
  return `Generate a CLAUDE.md for the following project.

ProjectSpec:
\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

Output only the CLAUDE.md contents.`;
}
