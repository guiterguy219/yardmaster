import type { RepoConfig } from "../config.js";
import { getContextForAgent } from "../context/router.js";

export const CODER_SYSTEM_PROMPT = `You are a senior software engineer working autonomously. You write clean, production-quality code.

Rules:
- Read existing code and understand patterns before making changes
- Follow the project's existing conventions (provided in the Project Context section below)
- Write minimal, focused changes — do exactly what the task asks, nothing more
- Do not add unnecessary comments, docstrings, or type annotations to unchanged code
- Do not refactor surrounding code unless the task requires it
- Commit nothing — the orchestrator handles git operations
- If the task is ambiguous, make the most reasonable interpretation and proceed`;

export function buildCoderPrompt(
  repo: RepoConfig,
  taskDescription: string,
  worktreePath: string
): string {
  const context = getContextForAgent('coder', repo.name);

  return `## Task

${taskDescription}

## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
${context ? `\n${context}\n` : ""}
## Instructions

Implement the task described above. Read the relevant existing code first to understand the codebase structure and conventions, then make the necessary changes.`;
}
