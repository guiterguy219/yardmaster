import { execSync } from "node:child_process";
import type { RepoConfig } from "../config.js";
import type { Worktree } from "../worktree.js";
import { ghExecEnv } from "../gh-auth.js";

export interface GitAgentResult {
  committed: boolean;
  pushed: boolean;
  prUrl: string | null;
  error?: string;
}

export function commitAndPush(
  repo: RepoConfig,
  worktree: Worktree,
  taskDescription: string,
  reviewSummary?: string,
  targetBranch?: string
): GitAgentResult {
  const cwd = worktree.path;

  // Check for changes
  const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
  if (!status) {
    return { committed: false, pushed: false, prUrl: null, error: "No changes to commit" };
  }

  // Stage and commit
  try {
    execSync("git add -A", { cwd, stdio: "pipe" });

    const commitMsg = `agent(code): ${truncate(taskDescription, 72)}`;
    execSync(`git commit -m ${shellEscape(commitMsg)}`, { cwd, stdio: "pipe" });
  } catch (err) {
    return {
      committed: false,
      pushed: false,
      prUrl: null,
      error: `Commit failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Push branch
  try {
    execSync(`git push -u origin "${worktree.branch}"`, { cwd, stdio: "pipe" });
  } catch (err) {
    return {
      committed: true,
      pushed: false,
      prUrl: null,
      error: `Push failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Create PR
  try {
    const reviewSection = reviewSummary ? `\n\n## Review Summary\n\n${reviewSummary}` : "";
    const prBody = `## Task\n\n${taskDescription}${reviewSection}\n\n---\n*Created by [Yardmaster](https://github.com/guiterguy219/yardmaster) — autonomous agent orchestration*`;

    const baseFlagArg = targetBranch ? `--base ${shellEscape(targetBranch)}` : "";
    const prUrl = execSync(
      `gh pr create --title ${shellEscape(`agent: ${truncate(taskDescription, 60)}`)} --body ${shellEscape(prBody)} --repo "${repo.githubOrg}/${repo.githubRepo}"${baseFlagArg ? " " + baseFlagArg : ""}`,
      { cwd, encoding: "utf-8", env: ghExecEnv(repo.githubOrg) }
    ).trim();

    return { committed: true, pushed: true, prUrl };
  } catch (err) {
    return {
      committed: true,
      pushed: true,
      prUrl: null,
      error: `PR creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function truncate(str: string, len: number): string {
  return str.length <= len ? str : str.slice(0, len - 3) + "...";
}

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
