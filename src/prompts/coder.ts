import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config.js";

export const CODER_SYSTEM_PROMPT = `You are a senior software engineer working autonomously. You write clean, production-quality code.

Rules:
- Read existing code and understand patterns before making changes
- Follow the project's existing conventions (check CLAUDE.md if it exists)
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
  let context = "";

  // Include CLAUDE.md if it exists
  const claudeMdPath = join(worktreePath, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, "utf-8");
    context += `\n\n## Project Context (from CLAUDE.md)\n\n${claudeMd}`;
  }

  return `## Task

${taskDescription}

## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
${context}

## Instructions

Implement the task described above. Read the relevant existing code first to understand the codebase structure and conventions, then make the necessary changes.`;
}
