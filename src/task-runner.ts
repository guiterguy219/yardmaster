import { execSync } from "node:child_process";
import { loadConfig, getRepo, type RepoConfig } from "./config.js";
import { createTask, updateTask, updatePipelineStage } from "./db.js";
import { checkCapacity } from "./capacity.js";
import { createWorktree, cleanupWorktree, saveWipWork, type Worktree } from "./worktree.js";
import { runReviewLoop } from "./review-loop.js";
import { runTestLoop } from "./test-loop.js";
import { runTestQualityAgent } from "./agents/test-quality.js";
import { runBrowserValidation } from "./browser-validation.js";
import { commitAndPush } from "./agents/git-agent.js";
import { analyzeFailure } from "./failure-analysis.js";
import { ingestRepo } from "./ingestor.js";
import { runIntegrationTests } from "./integration/runner.js";
import { notifyStarted, notifyPrCreated, notifyFailed } from "./issue-lifecycle.js";

export interface TaskResult {
  taskId: string;
  success: boolean;
  prUrl: string | null;
  error?: string;
}

export interface ExecuteTaskOptions {
  issueRef?: string;
  baseBranch?: string;
  targetBranch?: string;
}

export async function executeTask(
  repoName: string,
  description: string,
  options: ExecuteTaskOptions = {}
): Promise<TaskResult> {
  const { issueRef, baseBranch, targetBranch } = options;
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
  if (issueRef) {
    updateTask(taskId, { issue_ref: issueRef });
  }
  updateTask(taskId, { status: "running" });
  updatePipelineStage(taskId, "created", process.pid);
  console.log(`  Task ${taskId} created`);
  if (issueRef) {
    notifyStarted(issueRef, taskId);
  }

  let worktree: Worktree | null = null;

  try {
    // Create worktree
    console.log(`  Creating worktree...`);
    worktree = createWorktree(config, repo, taskId, baseBranch);
    updateTask(taskId, { branch: worktree.branch });
    updatePipelineStage(taskId, "worktree_created");
    console.log(`  Worktree: ${worktree.path}`);
    console.log(`  Branch: ${worktree.branch}`);

    // Ingest repo context (config files, dependencies)
    console.log(`  Ingesting repo context...`);
    const ingestResult = await ingestRepo(config, repoName, repo.localPath);
    console.log(`  Ingested ${ingestResult.filesChanged}/${ingestResult.filesScanned} files, ${ingestResult.chunksUpserted} chunks, ${ingestResult.depsUpserted} deps`);

    // Run review loop (coder + reviewers)
    console.log(`  Running review loop...`);
    const loopResult = await runReviewLoop(config, repo, taskId, worktree.path, description);

    console.log(
      `  Review loop complete: ${loopResult.finalVerdict} after ${loopResult.rounds} round(s)`
    );

    if (loopResult.converged) {
      updatePipelineStage(taskId, "review_complete");
    }

    if (!loopResult.converged) {
      // Try to save WIP work
      if (worktree) {
        const wip = saveWipWork(worktree, description);
        if (wip.saved) {
          console.log(`  WIP saved via ${wip.method}${wip.ref ? ` (${wip.ref})` : ""}`);
        }
      }

      const failError = `Review loop ended without convergence: ${loopResult.finalVerdict}`;
      updateTask(taskId, { status: "failed", error: failError });
      if (issueRef) notifyFailed(issueRef, taskId, failError);

      // Analyze failure pattern for self-improvement
      try {
        const category = await analyzeFailure(taskId, description, failError, loopResult.reviewSummary);
        console.log(`  Failure classified as: ${category}`);
      } catch {
        // Best effort
      }

      return { taskId, success: false, prUrl: null, error: failError };
    }

    // Run check command if configured
    if (repo.checkCommand) {
      console.log(`  Running check: ${repo.checkCommand}`);
      try {
        execSync(repo.checkCommand, { cwd: worktree.path, stdio: "pipe" });
        console.log(`  Check passed`);
        updatePipelineStage(taskId, "check_complete");
      } catch (err) {
        const checkError = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
        console.log(`  Check FAILED`);
        const checkFailError = `Check failed: ${checkError.slice(0, 200)}`;
        updateTask(taskId, { status: "failed", error: checkFailError });
        if (issueRef) notifyFailed(issueRef, taskId, checkFailError);
        return { taskId, success: false, prUrl: null, error: `Check command failed: ${repo.checkCommand}` };
      }
    }

    // Run test quality agent if test command is configured
    if (repo.testCommand) {
      console.log(`  Staging files for test quality analysis...`);
      execSync("git add -A", { cwd: worktree.path, stdio: "pipe" });
      const diff = execSync("git diff --cached", { cwd: worktree.path, stdio: "pipe" }).toString();

      if (diff.length > 0) {
        console.log(`  Running test quality agent...`);
        const tqResult = await runTestQualityAgent(config, repo, diff, worktree.path);
        console.log(`  Test quality: ${tqResult.summary.slice(0, 100)}`);

        if (tqResult.wrote) {
          execSync("git add -A", { cwd: worktree.path, stdio: "pipe" });
          updatePipelineStage(taskId, "tests_written");
        }
      }
    }

    // Run test loop if configured
    const testResult = await runTestLoop(config, repo, taskId, worktree.path, description);
    if (!testResult.passed) {
      const testError = `Tests failed after ${testResult.attempts} fix attempt(s)`;
      updateTask(taskId, { status: "failed", error: testError });
      if (issueRef) notifyFailed(issueRef, taskId, testError);
      return { taskId, success: false, prUrl: null, error: testError };
    }
    updatePipelineStage(taskId, "test_complete");

    // Run integration tests if configured
    console.log(`  Running integration tests...`);
    const integrationResult = await runIntegrationTests(config, repo, taskId, worktree.path, description);
    if (integrationResult.ran) {
      if (!integrationResult.passed) {
        const integrationError = `Integration tests failed after ${integrationResult.attempts} attempt(s)`;
        updateTask(taskId, { status: "failed", error: integrationError });
        if (issueRef) notifyFailed(issueRef, taskId, integrationError);
        return { taskId, success: false, prUrl: null, error: integrationError };
      }
      updatePipelineStage(taskId, "integration_test_complete");
      console.log(`  Integration tests passed`);
    } else {
      console.log(`  Integration tests skipped: ${integrationResult.output}`);
    }

    let reviewSummaryWithTests = loopResult.reviewSummary;
    if (testResult.attempts > 0) {
      reviewSummaryWithTests += `\n\nUnit tests: passed after ${testResult.attempts} attempt(s)`;
    }
    if (integrationResult.ran && integrationResult.passed) {
      reviewSummaryWithTests += `\n\nIntegration tests: passed${integrationResult.attempts > 0 ? ` after ${integrationResult.attempts} fix attempt(s)` : ""}`;
    }

    // Run browser validation if configured (best-effort)
    console.log(`  Running browser validation...`);
    const browserResult = await runBrowserValidation(config, repo, worktree.path);
    if (browserResult.ran && !browserResult.passed) {
      const browserError = `Browser validation failed: ${browserResult.output.slice(0, 200)}`;
      updateTask(taskId, { status: "failed", error: browserError });
      if (issueRef) notifyFailed(issueRef, taskId, browserError);
      return { taskId, success: false, prUrl: null, error: browserError };
    }
    if (!browserResult.ran) {
      console.log(`  Browser validation skipped: ${browserResult.output}`);
    } else {
      console.log(`  Browser validation passed`);
    }

    // Commit, push, and create PR
    console.log(`  Creating PR...`);
    const gitResult = commitAndPush(repo, worktree, description, reviewSummaryWithTests, targetBranch);

    if (gitResult.committed) {
      updatePipelineStage(taskId, "committed");
    }

    if (gitResult.prUrl) {
      updatePipelineStage(taskId, "pr_created");
      updateTask(taskId, { status: "completed", pr_url: gitResult.prUrl });
      if (issueRef) notifyPrCreated(issueRef, taskId, gitResult.prUrl);
      console.log(`  PR: ${gitResult.prUrl}`);
      return { taskId, success: true, prUrl: gitResult.prUrl };
    }

    if (gitResult.error) {
      updateTask(taskId, {
        status: gitResult.committed ? "partial" : "failed",
        error: gitResult.error,
      });
      if (issueRef) notifyFailed(issueRef, taskId, gitResult.error);
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
    if (issueRef) notifyFailed(issueRef, taskId, error);
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
