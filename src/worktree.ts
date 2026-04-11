import { execFileSync, execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { RepoConfig, YardmasterConfig } from "./config.js";
import { getTask } from "./db.js";

export interface Worktree {
  path: string;
  branch: string;
  taskId: string;
}

export function createWorktree(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  baseBranch?: string
): Worktree {
  const branch = `ym/${taskId}`;
  const worktreePath = join(config.worktreeBaseDir, taskId);
  const baseRef = baseBranch ?? repo.defaultBranch;

  mkdirSync(config.worktreeBaseDir, { recursive: true });

  // Fetch latest from remote
  execFileSync("git", ["fetch", "origin", baseRef], {
    cwd: repo.localPath,
    stdio: "pipe",
  });

  // Create worktree branching from latest remote ref
  execFileSync(
    "git",
    ["worktree", "add", worktreePath, "-b", branch, `origin/${baseRef}`],
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

export interface RemoveOrphanedWorktreesOptions {
  /** Also remove worktrees for interrupted tasks. Default: false (preserves recovery flow). */
  includeInterrupted?: boolean;
  /** Remove worktrees whose task ID is not found in the DB. Default: true. */
  removeUnknown?: boolean;
}

/**
 * Scan data/worktrees/, look up each directory name as a task ID (directory names are
 * the full task ID, e.g. ym-mnt9srfm), and remove worktrees whose tasks are missing or
 * in a terminal status (completed/failed, and optionally interrupted). Always skips
 * running/pending tasks.
 */
export function removeOrphanedWorktrees(
  config: YardmasterConfig,
  options: RemoveOrphanedWorktreesOptions = {}
): { removed: number; errors: string[] } {
  const { includeInterrupted = false, removeUnknown = true } = options;
  const { worktreeBaseDir } = config;

  if (!existsSync(worktreeBaseDir)) {
    return { removed: 0, errors: [] };
  }

  const entries = readdirSync(worktreeBaseDir, { withFileTypes: true });
  let removed = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    if (!taskId.startsWith("ym-")) continue;

    const task = getTask(taskId);

    if (task) {
      // Keep worktrees for active tasks
      if (task.status === "running" || task.status === "pending") continue;
      // Keep worktrees for interrupted tasks unless caller opts in (recovery needs them)
      if (task.status === "interrupted" && !includeInterrupted) continue;
    } else {
      // Task not in DB — skip unless removeUnknown is enabled
      if (!removeUnknown) continue;
    }

    const worktreePath = join(worktreeBaseDir, taskId);

    if (task) {
      const repo = config.repos.find((r) => r.name === task.repo);
      if (repo) {
        const worktree: Worktree = {
          path: worktreePath,
          branch: task.branch ?? `ym/${taskId}`,
          taskId,
        };
        try {
          cleanupWorktree(repo, worktree);
          console.log(`  Removed orphaned worktree for ${taskId} (${task.status})`);
          removed++;
        } catch (err) {
          errors.push(
            `Failed to cleanup ${taskId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        // Repo not in config — delete directory directly
        try {
          rmSync(worktreePath, { recursive: true, force: true });
          console.log(`  Removed orphaned worktree for ${taskId} (repo not in config)`);
          removed++;
        } catch (err) {
          errors.push(
            `Failed to delete ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } else {
      // Task missing from DB — delete directory directly
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        console.log(`  Removed orphaned worktree for ${taskId} (task not in DB)`);
        removed++;
      } catch (err) {
        errors.push(
          `Failed to delete ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return { removed, errors };
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
