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

export interface CleanupWorktreeOptions {
  /**
   * If true, the local branch is left in place so the work can be recovered later
   * (e.g. via `ym recover`). The worktree directory is still removed.
   */
  preserveBranch?: boolean;
}

export function cleanupWorktree(
  repo: RepoConfig,
  worktree: Worktree,
  options: CleanupWorktreeOptions = {}
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

  if (options.preserveBranch) {
    // Keep the branch around so failed work can be recovered.
    return;
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
 * Branch name used to preserve WIP work for a failed task. The branch is
 * pushed to `origin` so it survives worktree cleanup and can be recovered
 * later via `ym recover <taskId>`.
 */
export function preserveBranchName(taskId: string): string {
  return `ym-failed/${taskId}`;
}

export interface SaveWipResult {
  saved: boolean;
  method: "commit" | "stash" | "none";
  ref?: string;
  /** Local branch name that points at the WIP commit, if a preservation branch was created. */
  preserveBranch?: string;
  /** Remote ref (e.g. `origin/ym-failed/<taskId>`) when push succeeded. */
  remoteRef?: string;
  /** True iff the preservation branch was successfully pushed to origin. */
  pushed?: boolean;
}

/**
 * Attempt to save any in-progress work in a worktree.
 * Commit first; only stash as fallback if commit fails. When a commit is made,
 * also create a `ym-failed/<taskId>` branch and push it to origin so the work
 * survives worktree cleanup. If the push fails, the local branch and commit
 * are still left in place (best-effort).
 */
export function saveWipWork(
  worktree: Worktree,
  description: string
): SaveWipResult {
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

    // Create + push a preservation branch so the work survives worktree cleanup.
    const preserveBranch = preserveBranchName(worktree.taskId);
    let pushed = false;
    let remoteRef: string | undefined;
    try {
      // Force-create in case a stale local branch exists from a prior attempt.
      execSync(`git branch -f "${preserveBranch}" ${sha}`, { cwd, stdio: "pipe" });
      try {
        execSync(`git push -u --force-with-lease origin "${preserveBranch}"`, { cwd, stdio: "pipe" });
        pushed = true;
        remoteRef = `origin/${preserveBranch}`;
      } catch (err) {
        console.log(
          `  Warning: failed to push preservation branch ${preserveBranch}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } catch (err) {
      console.log(
        `  Warning: failed to create preservation branch ${preserveBranch}: ${err instanceof Error ? err.message : String(err)}`
      );
      return { saved: true, method: "commit", ref: sha };
    }

    return { saved: true, method: "commit", ref: sha, preserveBranch, pushed, remoteRef };
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
