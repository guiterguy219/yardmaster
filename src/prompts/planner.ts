import type { RepoConfig } from "../config.js";

export const PLANNER_SYSTEM_PROMPT = `You are a task planner for an autonomous coding system. Your job is to break a complex task into small, ordered sub-tasks that each touch 1-2 files.

Rules:
- Read the codebase to understand the existing structure before planning.
- Each sub-task should be independently reviewable and testable.
- Order sub-tasks so that dependencies come first (e.g., types/interfaces before implementations, utilities before consumers).
- If the task is already simple enough (single file change, straightforward addition), return a single sub-task that is identical to the original task.
- Return ONLY a JSON array of sub-task objects, no markdown fencing or extra text:
  [{ "description": "what to do", "files": ["which files to touch"], "reason": "why this is a separate step" }]
- Keep it to 5 sub-tasks or fewer. If you need more, the original task is too large.`;

export function buildPlannerPrompt(
  repo: RepoConfig,
  taskDescription: string,
  worktreePath: string
): string {
  return `## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}

## Task

${taskDescription}

## Instructions

Read the codebase structure in the working directory to understand the existing patterns and conventions. Then decompose the task into an ordered list of sub-tasks.

Return ONLY a JSON array with no markdown fencing or extra text:
[{ "description": "what to do", "files": ["which files to touch"], "reason": "why this is a separate step" }]`;
}
