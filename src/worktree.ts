import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { RepoConfig, YardmasterConfig } from "./config.js";

export interface Worktree {
  path: string;
  branch: string;
  taskId: string;
}

export function createWorktree(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string
): Worktree {
  const branch = `ym/${taskId}`;
  const worktreePath = join(config.worktreeBaseDir, taskId);

  mkdirSync(config.worktreeBaseDir, { recursive: true });

  // Fetch latest from remote
  execSync(`git fetch origin ${repo.defaultBranch}`, {
    cwd: repo.localPath,
    stdio: "pipe",
  });

  // Create worktree branching from latest remote default
  execSync(
    `git worktree add "${worktreePath}" -b "${branch}" "origin/${repo.defaultBranch}"`,
    { cwd: repo.localPath, stdio: "pipe" }
  );

  return { path: worktreePath, branch, taskId };
}

export function cleanupWorktree(
  repo: RepoConfig,
  worktree: Worktree
): void {
  try {
    // Remove the worktree
    execSync(`git worktree remove "${worktree.path}" --force`, {
      cwd: repo.localPath,
      stdio: "pipe",
    });
  } catch {
    // If worktree remove fails, try manual cleanup
    if (existsSync(worktree.path)) {
      rmSync(worktree.path, { recursive: true, force: true });
    }
    try {
      execSync("git worktree prune", { cwd: repo.localPath, stdio: "pipe" });
    } catch {
      // best effort
    }
  }

  // Delete the local branch
  try {
    execSync(`git branch -D "${worktree.branch}"`, {
      cwd: repo.localPath,
      stdio: "pipe",
    });
  } catch {
    // branch may already be gone
  }
}

/**
 * Attempt to save any in-progress work in a worktree.
 * Commit first; only stash as fallback if commit fails.
 */
export function saveWipWork(
  worktree: Worktree,
  description: string
): { saved: boolean; method: "commit" | "stash" | "none"; ref?: string } {
  const cwd = worktree.path;

  // Check if there are any changes
  const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
  if (!status) {
    return { saved: false, method: "none" };
  }

  // Try commit first
  try {
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync(`git commit -m "WIP: ${description}"`, { cwd, stdio: "pipe" });
    const sha = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
    return { saved: true, method: "commit", ref: sha };
  } catch {
    // Commit failed (maybe empty after add, or hook failure) — try stash
    try {
      execSync(`git stash push -m "WIP: ${description}"`, { cwd, stdio: "pipe" });
      return { saved: true, method: "stash" };
    } catch {
      return { saved: false, method: "none" };
    }
  }
}
