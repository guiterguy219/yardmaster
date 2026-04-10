import { loadConfig, getRepo } from "./config.js";
import { createTask, updateTask } from "./db.js";
import { checkCapacity } from "./capacity.js";
import { createWorktree, cleanupWorktree, saveWipWork, type Worktree } from "./worktree.js";
import { runReviewLoop } from "./review-loop.js";
import { commitAndPush } from "./agents/git-agent.js";

export interface TaskResult {
  taskId: string;
  success: boolean;
  prUrl: string | null;
  error?: string;
}

export async function executeTask(
  repoName: string,
  description: string
): Promise<TaskResult> {
  const config = loadConfig();
  const repo = getRepo(config, repoName);

  // Check capacity before starting
  const capacity = checkCapacity();
  if (!capacity.canProceed) {
    return {
      taskId: "",
      success: false,
      prUrl: null,
      error: `Capacity check failed: ${capacity.reason}`,
    };
  }
  if (capacity.isUsingOverage) {
    console.log(`  Warning: using overage capacity`);
  }

  // Create task record
  const taskId = createTask(repoName, description);
  updateTask(taskId, { status: "running" });
  console.log(`  Task ${taskId} created`);

  let worktree: Worktree | null = null;

  try {
    // Create worktree
    console.log(`  Creating worktree...`);
    worktree = createWorktree(config, repo, taskId);
    updateTask(taskId, { branch: worktree.branch });
    console.log(`  Worktree: ${worktree.path}`);
    console.log(`  Branch: ${worktree.branch}`);

    // Run review loop (coder + reviewers)
    console.log(`  Running review loop...`);
    const loopResult = await runReviewLoop(config, repo, taskId, worktree.path, description);

    console.log(
      `  Review loop complete: ${loopResult.finalVerdict} after ${loopResult.rounds} round(s)`
    );

    if (!loopResult.converged) {
      // Try to save WIP work
      if (worktree) {
        const wip = saveWipWork(worktree, description);
        if (wip.saved) {
          console.log(`  WIP saved via ${wip.method}${wip.ref ? ` (${wip.ref})` : ""}`);
        }
      }

      updateTask(taskId, {
        status: "failed",
        error: `Review loop ended without convergence: ${loopResult.finalVerdict}`,
      });
      return {
        taskId,
        success: false,
        prUrl: null,
        error: `Review loop ended without convergence: ${loopResult.finalVerdict}`,
      };
    }

    // Commit, push, and create PR
    console.log(`  Creating PR...`);
    const gitResult = commitAndPush(repo, worktree, description);

    if (gitResult.prUrl) {
      updateTask(taskId, { status: "completed", pr_url: gitResult.prUrl });
      console.log(`  PR: ${gitResult.prUrl}`);
      return { taskId, success: true, prUrl: gitResult.prUrl };
    }

    if (gitResult.error) {
      updateTask(taskId, {
        status: gitResult.committed ? "partial" : "failed",
        error: gitResult.error,
      });
      return { taskId, success: false, prUrl: null, error: gitResult.error };
    }

    updateTask(taskId, { status: "completed" });
    return { taskId, success: true, prUrl: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    // Try to save WIP work on unexpected errors
    if (worktree) {
      const wip = saveWipWork(worktree, description);
      if (wip.saved) {
        console.log(`  WIP saved via ${wip.method}`);
      }
    }

    updateTask(taskId, { status: "failed", error });
    return { taskId, success: false, prUrl: null, error };
  } finally {
    // Clean up worktree
    if (worktree) {
      try {
        cleanupWorktree(repo, worktree);
        console.log(`  Worktree cleaned up`);
      } catch {
        console.log(`  Warning: worktree cleanup failed at ${worktree.path}`);
      }
    }
  }
}
