import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getRepo, type YardmasterConfig } from "./config.js";
import {
  getInterruptedTasks,
  getRunningTasks,
  updateTask,
  updatePipelineStage,
  claimInterruptedTask,
  type TaskRow,
} from "./db.js";
import { runTestLoop } from "./test-loop.js";
import { commitAndPush } from "./agents/git-agent.js";
import { notifyPrCreated, notifyFailed } from "./issue-lifecycle.js";

const YARDMASTER_CMDLINE_MARKERS = ["yardmaster", "claude"];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // kill(0) succeeded — PID exists. Verify via /proc on Linux to guard against PID reuse.
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      // If the process cmdline doesn't contain a known yardmaster marker, the PID was
      // reused by an unrelated process — treat the original worker as dead.
      const isYardmasterProcess = YARDMASTER_CMDLINE_MARKERS.some((marker) =>
        cmdline.includes(marker)
      );
      return isYardmasterProcess;
    } catch {
      // /proc not available (macOS) — trust kill(0) result
      return true;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = process does not exist
    if (code === "ESRCH") return false;
    // EPERM = PID exists but belongs to a different (privileged) user — check /proc anyway
    // to detect cases where a dead worker's PID was reused by a root process
    if (code === "EPERM") {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        const isYardmasterProcess = YARDMASTER_CMDLINE_MARKERS.some((marker) =>
          cmdline.includes(marker)
        );
        return isYardmasterProcess;
      } catch {
        // /proc not available or EACCES — cannot verify; treat as dead to avoid stuck tasks
        console.warn(`  Warning: cannot verify pid ${pid} (EPERM, no /proc) — treating as dead`);
        return false;
      }
    }
    return true; // unknown error — assume alive
  }
}

/**
 * Scan all running tasks and mark those whose worker PIDs are dead as interrupted.
 * Returns the number of tasks newly marked interrupted.
 */
export function detectAndMarkInterrupted(): number {
  const running = getRunningTasks();
  let marked = 0;

  for (const task of running) {
    if (task.worker_pid == null) {
      // PID not yet recorded — task may have just been created; skip to avoid race window
      continue;
    }
    if (!isPidAlive(task.worker_pid)) {
      console.log(`  Detected dead worker for ${task.id} (pid: ${task.worker_pid})`);
      updateTask(task.id, { status: "interrupted", error: "Worker process died unexpectedly" });
      marked++;
    }
  }

  return marked;
}

/**
 * Attempt to resume all interrupted tasks from their last known pipeline stage.
 * Tasks interrupted in early stages (before review_complete) are cleaned up and
 * marked failed — they cannot be resumed without re-running the full pipeline.
 * Tasks at review_complete or later are resumed: check → test → commit → PR.
 */
export async function recoverInterruptedTasks(config: YardmasterConfig): Promise<{
  recovered: number;
  failed: number;
  skipped: number;
}> {
  const tasks = getInterruptedTasks();
  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const task of tasks) {
    const worktreePath = join(config.worktreeBaseDir, task.id);

    if (!existsSync(worktreePath)) {
      console.log(`  Skipping ${task.id}: worktree not found at ${worktreePath}`);
      skipped++;
      continue;
    }

    let repo: ReturnType<typeof getRepo>;
    try {
      repo = getRepo(config, task.repo);
    } catch {
      console.log(`  Skipping ${task.id}: repo "${task.repo}" not in config`);
      skipped++;
      continue;
    }

    const stage = task.pipeline_stage;
    const issueRef = task.issue_ref;
    console.log(`  Recovering ${task.id} (stage: ${stage ?? "unknown"}, repo: ${task.repo})`);

    const worktree = {
      path: worktreePath,
      branch: task.branch ?? `ym/${task.id}`,
      taskId: task.id,
    };

    try {
      // Atomically claim the task — if another worker already claimed it, skip
      if (!claimInterruptedTask(task.id)) {
        console.log(`  Skipping ${task.id}: already claimed by another worker`);
        skipped++;
        continue;
      }

      // Early stages (before review_complete) cannot be resumed — code is incomplete.
      // Clean up the worktree and mark the task as failed.
      if (!stage || stage === "created" || stage === "worktree_created") {
        console.log(`  Cleaning up ${task.id}: interrupted before review was complete`);
        if (existsSync(worktreePath)) {
          try {
            execSync(`git worktree remove "${worktreePath}" --force`, {
              cwd: repo.localPath,
              stdio: "pipe",
            });
          } catch {
            try {
              rmSync(worktreePath, { recursive: true, force: true });
              execSync("git worktree prune", { cwd: repo.localPath, stdio: "pipe" });
            } catch {
              // best effort
            }
          }
        }
        updateTask(task.id, {
          status: "failed",
          error: "Interrupted before review was complete — cannot resume",
        });
        if (issueRef) notifyFailed(issueRef, task.id, "Interrupted before review was complete — cannot resume");
        failed++;
        continue;
      }
      updatePipelineStage(task.id, stage, process.pid);

      // Stages that still need check + test + commit + PR
      const needsCheck = stage === "review_complete";
      const needsTest = needsCheck || stage === "check_complete";
      const needsCommit = needsTest || stage === "test_complete";

      if (needsCheck && repo.checkCommand) {
        console.log(`  Running check: ${repo.checkCommand}`);
        try {
          execSync(repo.checkCommand, { cwd: worktreePath, stdio: "pipe" });
          console.log(`  Check passed`);
          updatePipelineStage(task.id, "check_complete");
        } catch (err) {
          const checkError =
            err instanceof Error
              ? (err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString() || err.message
              : String(err);
          console.log(`  Check FAILED`);
          updateTask(task.id, {
            status: "failed",
            error: `Recovery check failed: ${checkError.slice(0, 200)}`,
          });
          if (issueRef) notifyFailed(issueRef, task.id, `Recovery check failed: ${checkError.slice(0, 200)}`);
          failed++;
          continue;
        }
      }

      if (needsTest) {
        const testResult = await runTestLoop(config, repo, task.id, worktreePath, task.description);
        if (!testResult.passed) {
          const testError = `Tests failed after ${testResult.attempts} fix attempt(s)`;
          updateTask(task.id, { status: "failed", error: testError });
          if (issueRef) notifyFailed(issueRef, task.id, testError);
          failed++;
          continue;
        }
        updatePipelineStage(task.id, "test_complete");
      }

      if (needsCommit) {
        const gitResult = commitAndPush(repo, worktree, task.description);

        if (gitResult.committed) {
          updatePipelineStage(task.id, "committed");
        }

        if (gitResult.prUrl) {
          updatePipelineStage(task.id, "pr_created");
          updateTask(task.id, { status: "completed", pr_url: gitResult.prUrl });
          if (issueRef) notifyPrCreated(issueRef, task.id, gitResult.prUrl);
          console.log(`  Recovered ${task.id}: PR ${gitResult.prUrl}`);
          recovered++;
        } else if (gitResult.error) {
          updateTask(task.id, {
            status: gitResult.committed ? "partial" : "failed",
            error: gitResult.error,
          });
          if (issueRef) notifyFailed(issueRef, task.id, gitResult.error);
          failed++;
        } else {
          if (!gitResult.committed) {
            console.log(
              `  Warning: ${task.id} — commitAndPush returned committed:false with no error (possible empty diff)`
            );
          }
          updateTask(task.id, { status: "completed" });
          recovered++;
        }
      } else if (stage === "committed") {
        // Already committed and pushed — just need PR creation
        try {
          const repoSlugPattern = /^[\w.-]+$/;
          if (!repoSlugPattern.test(repo.githubOrg) || !repoSlugPattern.test(repo.githubRepo)) {
            throw new Error(
              `Invalid repo slug — githubOrg or githubRepo contains unsafe characters: "${repo.githubOrg}/${repo.githubRepo}"`
            );
          }
          const prBody = `## Task\n\n${task.description}\n\n---\n*Recovered by [Yardmaster](https://github.com/guiterguy219/yardmaster)*`;
          const title = `agent: ${task.description.slice(0, 60)}${task.description.length > 60 ? "..." : ""}`;
          const prUrl = execFileSync(
            "gh",
            [
              "pr", "create",
              "--title", title,
              "--body", prBody,
              "--repo", `${repo.githubOrg}/${repo.githubRepo}`,
            ],
            { cwd: worktreePath, encoding: "utf-8" }
          ).trim();
          updatePipelineStage(task.id, "pr_created");
          updateTask(task.id, { status: "completed", pr_url: prUrl });
          if (issueRef) notifyPrCreated(issueRef, task.id, prUrl);
          console.log(`  Recovered ${task.id}: PR ${prUrl}`);
          recovered++;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          updateTask(task.id, { status: "partial", error: `PR creation failed: ${error}` });
          if (issueRef) notifyFailed(issueRef, task.id, `PR creation failed: ${error}`);
          failed++;
        }
      } else if (stage === "pr_created") {
        // PR already created — mark as completed using the recorded PR URL
        updateTask(task.id, { status: "completed", pr_url: task.pr_url ?? undefined });
        console.log(`  Recovered ${task.id}: PR already created${task.pr_url ? ` (${task.pr_url})` : ""}`);
        recovered++;
      } else {
        // Unknown or future stage — cannot resume; mark failed to break any recovery loop
        updateTask(task.id, {
          status: "failed",
          error: `Unknown or unresumable pipeline stage: ${stage}`,
        });
        if (issueRef) notifyFailed(issueRef, task.id, `Unknown or unresumable pipeline stage: ${stage}`);
        failed++;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`  Recovery failed for ${task.id}: ${error}`);
      updateTask(task.id, { status: "failed", error: `Recovery failed: ${error}` });
      if (issueRef) notifyFailed(issueRef, task.id, `Recovery failed: ${error}`);
      failed++;
    }
  }

  return { recovered, failed, skipped };
}
