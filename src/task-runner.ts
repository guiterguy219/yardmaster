import { execSync } from "node:child_process";
import { loadConfig, getRepo, type YardmasterConfig, type RepoConfig } from "./config.js";
import { createTask, updateTask, updatePipelineStage } from "./db.js";
import { checkCapacity } from "./capacity.js";
import { createWorktree, cleanupWorktree, saveWipWork, type Worktree } from "./worktree.js";
import { runReviewLoop } from "./review-loop.js";
import { runTestLoop } from "./test-loop.js";
import { runCoder } from "./agents/coder.js";
import { runTestQualityAgent } from "./agents/test-quality.js";
import { runBrowserValidation } from "./browser-validation.js";
import { commitAndPush } from "./agents/git-agent.js";
import { analyzeFailure } from "./failure-analysis.js";
import { ingestRepo } from "./ingestor.js";
import { runIntegrationTests } from "./integration/runner.js";
import { notifyStarted, notifyPrCreated, notifyFailed } from "./issue-lifecycle.js";
import { runDiagnosticLoop } from "./diagnostician.js";

const MAX_CHECK_FIX_ATTEMPTS = 2;

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
  noDiagnose?: boolean;
}

export async function executeTask(
  repoName: string,
  description: string,
  options: ExecuteTaskOptions = {}
): Promise<TaskResult> {
  const { issueRef, baseBranch, targetBranch, noDiagnose } = options;
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
  let diagnosticAttempted = false;
  let activeDescription = description;

  /**
   * Attempt diagnosis on a pipeline failure. Returns true if the task was
   * recovered and the caller should retry from the appropriate stage.
   */
  async function diagnose(
    stage: string,
    error: string
  ): Promise<{ recovered: boolean; newSpec?: string }> {
    if (diagnosticAttempted || noDiagnose || !worktree) return { recovered: false };
    diagnosticAttempted = true;

    try {
      const diagResult = await runDiagnosticLoop(
        config, repo, taskId, worktree.path, stage, error, activeDescription
      );
      if (diagResult.recovered) {
        if (diagResult.newSpec) {
          activeDescription = diagResult.newSpec;
          return { recovered: true, newSpec: diagResult.newSpec };
        }
        return { recovered: true };
      }
    } catch (diagErr) {
      console.log(`  [Diagnostician] Error: ${diagErr instanceof Error ? diagErr.message : String(diagErr)}`);
    }
    return { recovered: false };
  }

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

    // ── Review loop ──────────────────────────────────────
    // May run twice: once normally, once if diagnostician provides retry_with_spec
    let reviewConverged = false;
    let reviewSummary = "";

    for (let reviewAttempt = 0; reviewAttempt < 2; reviewAttempt++) {
      console.log(`  Running review loop...`);
      const loopResult = await runReviewLoop(config, repo, taskId, worktree.path, activeDescription);

      console.log(
        `  Review loop complete: ${loopResult.finalVerdict} after ${loopResult.rounds} round(s)`
      );

      reviewSummary = loopResult.reviewSummary;

      if (loopResult.converged) {
        updatePipelineStage(taskId, "review_complete");
        reviewConverged = true;
        break;
      }

      // Review didn't converge — attempt diagnosis
      if (worktree) {
        const wip = saveWipWork(worktree, description);
        if (wip.saved) {
          console.log(`  WIP saved via ${wip.method}${wip.ref ? ` (${wip.ref})` : ""}`);
        }
      }

      const failError = `Review loop ended without convergence: ${loopResult.finalVerdict}`;

      const recovery = await diagnose("review_loop", failError);
      if (recovery.recovered) {
        // Diagnostician fixed something or rewrote the spec — retry the review loop
        console.log(`  [Diagnostician] Retrying review loop...`);
        continue;
      }

      // Not recovered — fail the task
      updateTask(taskId, { status: "failed", error: failError });
      if (issueRef) notifyFailed(issueRef, taskId, failError);

      try {
        const category = await analyzeFailure(taskId, activeDescription, failError, loopResult.reviewSummary);
        console.log(`  Failure classified as: ${category}`);
      } catch {
        // Best effort
      }

      return { taskId, success: false, prUrl: null, error: failError };
    }

    if (!reviewConverged) {
      const failError = "Review loop did not converge after diagnostic retry";
      updateTask(taskId, { status: "failed", error: failError });
      if (issueRef) notifyFailed(issueRef, taskId, failError);
      return { taskId, success: false, prUrl: null, error: failError };
    }

    // ── Check command ────────────────────────────────────
    if (repo.checkCommand) {
      const checkResult = await runCheckWithFixes(config, repo, worktree.path, activeDescription);

      if (!checkResult.passed) {
        const checkFailError = `Check failed after ${MAX_CHECK_FIX_ATTEMPTS} fix attempts: ${checkResult.output.slice(0, 200)}`;
        const recovery = await diagnose("check_command", checkFailError);
        if (recovery.recovered) {
          // Diagnostician fixed env issue — re-run check once
          console.log(`  [Diagnostician] Retrying check command...`);
          try {
            execSync(repo.checkCommand, { cwd: worktree.path, encoding: "utf-8", stdio: "pipe" });
            console.log(`  Check passed after diagnostic fix`);
          } catch {
            updateTask(taskId, { status: "failed", error: checkFailError });
            if (issueRef) notifyFailed(issueRef, taskId, checkFailError);
            return { taskId, success: false, prUrl: null, error: `Check command failed: ${repo.checkCommand}` };
          }
        } else {
          updateTask(taskId, { status: "failed", error: checkFailError });
          if (issueRef) notifyFailed(issueRef, taskId, checkFailError);
          return { taskId, success: false, prUrl: null, error: `Check command failed: ${repo.checkCommand}` };
        }
      }

      updatePipelineStage(taskId, "check_complete");
    }

    // ── Test quality agent ───────────────────────────────
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

    // ── Test loop ────────────────────────────────────────
    const testResult = await runTestLoop(config, repo, taskId, worktree.path, activeDescription);
    if (!testResult.passed) {
      const testError = `Tests failed after ${testResult.attempts} fix attempt(s)`;
      const recovery = await diagnose("test_loop", testError);
      if (recovery.recovered) {
        console.log(`  [Diagnostician] Retrying test loop...`);
        const retryTestResult = await runTestLoop(config, repo, taskId, worktree.path, activeDescription);
        if (!retryTestResult.passed) {
          updateTask(taskId, { status: "failed", error: testError });
          if (issueRef) notifyFailed(issueRef, taskId, testError);
          return { taskId, success: false, prUrl: null, error: testError };
        }
      } else {
        updateTask(taskId, { status: "failed", error: testError });
        if (issueRef) notifyFailed(issueRef, taskId, testError);
        return { taskId, success: false, prUrl: null, error: testError };
      }
    }
    updatePipelineStage(taskId, "test_complete");

    // ── Integration tests ────────────────────────────────
    console.log(`  Running integration tests...`);
    const integrationResult = await runIntegrationTests(config, repo, taskId, worktree.path, activeDescription);
    if (integrationResult.ran) {
      if (!integrationResult.passed) {
        const integrationError = `Integration tests failed after ${integrationResult.attempts} attempt(s)`;
        const recovery = await diagnose("integration_tests", integrationError);
        if (recovery.recovered) {
          console.log(`  [Diagnostician] Retrying integration tests...`);
          const retryIntResult = await runIntegrationTests(config, repo, taskId, worktree.path, activeDescription);
          if (!retryIntResult.passed) {
            updateTask(taskId, { status: "failed", error: integrationError });
            if (issueRef) notifyFailed(issueRef, taskId, integrationError);
            return { taskId, success: false, prUrl: null, error: integrationError };
          }
        } else {
          updateTask(taskId, { status: "failed", error: integrationError });
          if (issueRef) notifyFailed(issueRef, taskId, integrationError);
          return { taskId, success: false, prUrl: null, error: integrationError };
        }
      }
      updatePipelineStage(taskId, "integration_test_complete");
      console.log(`  Integration tests passed`);
    } else {
      console.log(`  Integration tests skipped: ${integrationResult.output}`);
    }

    let reviewSummaryWithTests = reviewSummary;
    if (testResult.attempts > 0) {
      reviewSummaryWithTests += `\n\nUnit tests: passed after ${testResult.attempts} attempt(s)`;
    }
    if (integrationResult.ran && integrationResult.passed) {
      reviewSummaryWithTests += `\n\nIntegration tests: passed${integrationResult.attempts > 0 ? ` after ${integrationResult.attempts} fix attempt(s)` : ""}`;
    }

    // ── Browser validation ───────────────────────────────
    console.log(`  Running browser validation...`);
    const browserResult = await runBrowserValidation(config, repo, worktree.path);
    if (browserResult.ran && !browserResult.passed) {
      const browserError = `Browser validation failed: ${browserResult.output.slice(0, 200)}`;
      const recovery = await diagnose("browser_validation", browserError);
      if (!recovery.recovered) {
        updateTask(taskId, { status: "failed", error: browserError });
        if (issueRef) notifyFailed(issueRef, taskId, browserError);
        return { taskId, success: false, prUrl: null, error: browserError };
      }
      // If recovered, proceed — the fix was environmental
    }
    if (!browserResult.ran) {
      console.log(`  Browser validation skipped: ${browserResult.output}`);
    } else {
      console.log(`  Browser validation passed`);
    }

    // ── Final check ──────────────────────────────────────
    if (repo.checkCommand) {
      console.log(`  Final check: ${repo.checkCommand}`);
      try {
        execSync(repo.checkCommand, { cwd: worktree.path, stdio: "pipe" });
        console.log(`  Final check passed`);
      } catch (err) {
        const checkError = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
        console.log(`  Final check FAILED`);
        const finalCheckError = `Final check failed: ${checkError.slice(0, 200)}`;

        const recovery = await diagnose("final_check", finalCheckError);
        if (recovery.recovered) {
          console.log(`  [Diagnostician] Retrying final check...`);
          try {
            execSync(repo.checkCommand, { cwd: worktree.path, stdio: "pipe" });
            console.log(`  Final check passed after diagnostic fix`);
          } catch {
            updateTask(taskId, { status: "failed", error: finalCheckError });
            if (issueRef) notifyFailed(issueRef, taskId, finalCheckError);
            return { taskId, success: false, prUrl: null, error: `Final check failed: ${repo.checkCommand}` };
          }
        } else {
          updateTask(taskId, { status: "failed", error: finalCheckError });
          if (issueRef) notifyFailed(issueRef, taskId, finalCheckError);
          return { taskId, success: false, prUrl: null, error: `Final check failed: ${repo.checkCommand}` };
        }
      }
    }

    // ── Commit, push, and create PR ──────────────────────
    console.log(`  Creating PR...`);
    const gitResult = commitAndPush(repo, worktree, activeDescription, reviewSummaryWithTests, targetBranch);

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
      const recovery = await diagnose("git_push", gitResult.error);
      if (recovery.recovered) {
        console.log(`  [Diagnostician] Retrying commit and push...`);
        const retryGitResult = commitAndPush(repo, worktree, activeDescription, reviewSummaryWithTests, targetBranch);
        if (retryGitResult.prUrl) {
          updatePipelineStage(taskId, "pr_created");
          updateTask(taskId, { status: "completed", pr_url: retryGitResult.prUrl });
          if (issueRef) notifyPrCreated(issueRef, taskId, retryGitResult.prUrl);
          console.log(`  PR: ${retryGitResult.prUrl}`);
          return { taskId, success: true, prUrl: retryGitResult.prUrl };
        }
      }

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

    // Attempt diagnosis on unexpected errors (before saving WIP)
    if (worktree) {
      const recovery = await diagnose("unexpected_error", error);
      if (recovery.recovered) {
        // Can't meaningfully retry from an unexpected error — log diagnosis and fail
        console.log(`  [Diagnostician] Diagnosed unexpected error but cannot auto-retry`);
      }
    }

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

/**
 * Run the check command with up to 2 coder fix attempts.
 * Extracted to keep the main pipeline readable.
 */
async function runCheckWithFixes(
  config: YardmasterConfig,
  repo: RepoConfig,
  worktreePath: string,
  description: string
): Promise<{ passed: boolean; output: string }> {
  console.log(`  Running check: ${repo.checkCommand}`);
  let checkOutput = "";

  // Initial check
  try {
    execSync(repo.checkCommand!, { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" });
    console.log(`  Check passed`);
    return { passed: true, output: "" };
  } catch (err) {
    checkOutput = (err as any).stderr?.toString() || (err as any).stdout?.toString() || (err instanceof Error ? err.message : String(err));
    console.log(`  Check FAILED`);
  }

  // Fix attempts
  for (let attempt = 1; attempt <= MAX_CHECK_FIX_ATTEMPTS; attempt++) {
    console.log(`  Check fix attempt ${attempt}/${MAX_CHECK_FIX_ATTEMPTS}...`);
    const fixPrompt = `${description}

## Check Failures

The check command \`${repo.checkCommand}\` failed. Here is the output:

${checkOutput.slice(0, 4000)}

Fix the code so the check passes. These are likely TypeScript type errors.`;

    await runCoder(config, repo, fixPrompt, worktreePath);

    console.log(`  Re-running check...`);
    try {
      execSync(repo.checkCommand!, { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" });
      console.log(`  Check passed after ${attempt} fix attempt(s)`);
      return { passed: true, output: "" };
    } catch (err) {
      checkOutput = (err as any).stderr?.toString() || (err as any).stdout?.toString() || (err instanceof Error ? err.message : String(err));
      console.log(`  Check FAILED`);
    }
  }

  return { passed: false, output: checkOutput };
}
