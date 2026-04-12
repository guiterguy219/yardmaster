import { execSync } from "node:child_process";
import { loadConfig, getRepo, type RepoConfig } from "./config.js";
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
import { notifyTaskStarted, notifyTaskCompleted, notifyTaskFailed, notifyPipelineStage } from "./telegram/notify.js";
import { runDiagnosticLoop } from "./diagnostician.js";

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
  initialDescription: string,
  options: ExecuteTaskOptions = {}
): Promise<TaskResult> {
  const { issueRef, baseBranch, targetBranch, noDiagnose } = options;
  const config = loadConfig();
  const repo = getRepo(config, repoName);
  let description = initialDescription;
  const diagnosticAttempted = new Set<string>();

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
  } else {
    notifyTaskStarted(taskId, repoName, description);
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
    let loopResult = await runReviewLoop(config, repo, taskId, worktree.path, description);

    console.log(
      `  Review loop complete: ${loopResult.finalVerdict} after ${loopResult.rounds} round(s)`
    );

    if (loopResult.converged) {
      updatePipelineStage(taskId, "review_complete");
      notifyPipelineStage(taskId, repoName, `Review: ${loopResult.finalVerdict} in ${loopResult.rounds} round(s)`);
    }

    if (!loopResult.converged) {
      const failError = `Review loop ended without convergence: ${loopResult.finalVerdict}`;

      // Run diagnostician before giving up
      if (!noDiagnose && !diagnosticAttempted.has("review_loop") && worktree) {
        diagnosticAttempted.add("review_loop");
        const diagResult = await runDiagnosticLoop(
          config, repo, taskId, worktree.path, "review_loop", failError, description
        );
        if (diagResult.recovered) {
          if (diagResult.action === "retry_with_spec" && diagResult.newSpec) {
            console.log(`  Retrying review loop with rewritten spec...`);
            description = diagResult.newSpec;
          } else {
            console.log(`  Retrying review loop...`);
          }
          const retryResult = await runReviewLoop(config, repo, taskId, worktree.path, description);
          if (retryResult.converged) {
            console.log(`  Review loop converged on retry after diagnosis`);
            updatePipelineStage(taskId, "review_complete");
            notifyPipelineStage(taskId, repoName, `Review: ${retryResult.finalVerdict} in ${retryResult.rounds} round(s) (after diagnostic retry)`);
            loopResult = retryResult;
          }
          // If retry also failed, fall through to failure handling below
          if (!retryResult.converged) {
            const retryError = `Review loop failed on diagnostic retry: ${retryResult.finalVerdict}`;
            if (worktree) {
              const wip = saveWipWork(worktree, description);
              if (wip.saved) console.log(`  WIP saved via ${wip.method}${wip.ref ? ` (${wip.ref})` : ""}`);
            }
            updateTask(taskId, { status: "failed", error: retryError });
            if (issueRef) notifyFailed(issueRef, taskId, retryError);
            else notifyTaskFailed(taskId, repoName, retryError);
            return { taskId, success: false, prUrl: null, error: retryError };
          }
        } else {
          // Diagnostician couldn't recover
          if (worktree) {
            const wip = saveWipWork(worktree, description);
            if (wip.saved) console.log(`  WIP saved via ${wip.method}${wip.ref ? ` (${wip.ref})` : ""}`);
          }
          updateTask(taskId, { status: "failed", error: `${failError} — ${diagResult.diagnosis}` });
          if (issueRef) notifyFailed(issueRef, taskId, failError);
          else notifyTaskFailed(taskId, repoName, failError);
          return { taskId, success: false, prUrl: null, error: failError };
        }
      } else {
        // No diagnosis — original behavior
        if (worktree) {
          const wip = saveWipWork(worktree, description);
          if (wip.saved) console.log(`  WIP saved via ${wip.method}${wip.ref ? ` (${wip.ref})` : ""}`);
        }
        updateTask(taskId, { status: "failed", error: failError });
        if (issueRef) notifyFailed(issueRef, taskId, failError);
        else notifyTaskFailed(taskId, repoName, failError);

        try {
          const category = await analyzeFailure(taskId, description, failError, loopResult.reviewSummary);
          console.log(`  Failure classified as: ${category}`);
        } catch {
          // Best effort
        }

        return { taskId, success: false, prUrl: null, error: failError };
      }
    }

    // Run check command if configured (with fix attempts)
    if (repo.checkCommand) {
      console.log(`  Running check: ${repo.checkCommand}`);
      let checkPassed = false;
      let checkOutput = "";
      const MAX_CHECK_FIX_ATTEMPTS = 2;

      // Initial check
      try {
        execSync(repo.checkCommand, { cwd: worktree.path, encoding: "utf-8", stdio: "pipe" });
        checkPassed = true;
        console.log(`  Check passed`);
      } catch (err) {
        checkOutput = (err as any).stderr?.toString() || (err as any).stdout?.toString() || (err instanceof Error ? err.message : String(err));
        console.log(`  Check FAILED`);
      }

      // Fix attempts if check failed
      if (!checkPassed) {
        for (let attempt = 1; attempt <= MAX_CHECK_FIX_ATTEMPTS; attempt++) {
          console.log(`  Check fix attempt ${attempt}/${MAX_CHECK_FIX_ATTEMPTS}...`);
          const fixPrompt = `${description}

## Check Failures

The check command \`${repo.checkCommand}\` failed. Here is the output:

${checkOutput.slice(0, 4000)}

Fix the code so the check passes. These are likely TypeScript type errors.`;

          await runCoder(config, repo, fixPrompt, worktree.path);

          console.log(`  Re-running check...`);
          try {
            execSync(repo.checkCommand, { cwd: worktree.path, encoding: "utf-8", stdio: "pipe" });
            checkPassed = true;
            console.log(`  Check passed after ${attempt} fix attempt(s)`);
            break;
          } catch (err) {
            checkOutput = (err as any).stderr?.toString() || (err as any).stdout?.toString() || (err instanceof Error ? err.message : String(err));
            console.log(`  Check FAILED`);
          }
        }
      }

      if (!checkPassed) {
        const checkFailError = `Check failed after ${MAX_CHECK_FIX_ATTEMPTS} fix attempts: ${checkOutput.slice(0, 200)}`;

        if (!noDiagnose && !diagnosticAttempted.has("check_command") && worktree) {
          diagnosticAttempted.add("check_command");
          const diagResult = await runDiagnosticLoop(
            config, repo, taskId, worktree.path, "check_command", checkFailError, description
          );
          if (diagResult.recovered) {
            console.log(`  Retrying check after diagnosis...`);
            try {
              execSync(repo.checkCommand!, { cwd: worktree.path, encoding: "utf-8", stdio: "pipe" });
              checkPassed = true;
              console.log(`  Check passed after diagnostic fix`);
            } catch {
              console.log(`  Check still fails after diagnostic fix`);
            }
          }
        }

        if (!checkPassed) {
          updateTask(taskId, { status: "failed", error: checkFailError });
          if (issueRef) notifyFailed(issueRef, taskId, checkFailError);
          else notifyTaskFailed(taskId, repoName, checkFailError);
          return { taskId, success: false, prUrl: null, error: `Check command failed: ${repo.checkCommand}` };
        }
      }

      updatePipelineStage(taskId, "check_complete");
      notifyPipelineStage(taskId, repoName, `Check passed: ${repo.checkCommand}`);
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

          // Run check command (if configured) to catch type errors in newly-written tests.
          // Feed any failures back to the test-quality agent so it can fix them before
          // the final gate. This prevents broken tests from killing the task downstream.
          if (repo.checkCommand) {
            const MAX_TQ_FIX_ATTEMPTS = 2;
            let tqCheckPassed = false;
            let tqCheckOutput = "";

            try {
              execSync(repo.checkCommand, { cwd: worktree.path, encoding: "utf-8", stdio: "pipe" });
              tqCheckPassed = true;
            } catch (err) {
              tqCheckOutput = (err as any).stderr?.toString() || (err as any).stdout?.toString() || (err instanceof Error ? err.message : String(err));
              console.log(`  Test quality check FAILED — tests have type errors`);
            }

            for (let attempt = 1; !tqCheckPassed && attempt <= MAX_TQ_FIX_ATTEMPTS; attempt++) {
              console.log(`  Test quality fix attempt ${attempt}/${MAX_TQ_FIX_ATTEMPTS}...`);
              const fixPrompt = `${description}

## Test Type Errors

The tests just written produced TypeScript errors when running \`${repo.checkCommand}\`. Fix the test files so the check passes. Prefer fixing the tests; only modify source code if the tests reveal a genuine type bug.

## Check Output

${tqCheckOutput.slice(0, 4000)}`;
              await runCoder(config, repo, fixPrompt, worktree.path);
              execSync("git add -A", { cwd: worktree.path, stdio: "pipe" });

              try {
                execSync(repo.checkCommand, { cwd: worktree.path, encoding: "utf-8", stdio: "pipe" });
                tqCheckPassed = true;
                console.log(`  Test quality check passed after ${attempt} fix attempt(s)`);
              } catch (err) {
                tqCheckOutput = (err as any).stderr?.toString() || (err as any).stdout?.toString() || (err instanceof Error ? err.message : String(err));
              }
            }

            if (!tqCheckPassed) {
              console.log(`  Test quality check still failing after ${MAX_TQ_FIX_ATTEMPTS} attempts — final check will catch it`);
            }
          }
        }
      }
    }

    // Run test loop if configured
    let testResult = await runTestLoop(config, repo, taskId, worktree.path, description);
    if (!testResult.passed) {
      const testError = `Tests failed after ${testResult.attempts} fix attempt(s)`;

      if (!noDiagnose && !diagnosticAttempted.has("test_loop") && worktree) {
        diagnosticAttempted.add("test_loop");
        const diagResult = await runDiagnosticLoop(
          config, repo, taskId, worktree.path, "test_loop", testError, description
        );
        if (diagResult.recovered) {
          console.log(`  Retrying test loop after diagnosis...`);
          testResult = await runTestLoop(config, repo, taskId, worktree.path, description);
        }
      }

      if (!testResult.passed) {
        const finalTestError = `Tests failed after ${testResult.attempts} fix attempt(s)`;
        updateTask(taskId, { status: "failed", error: finalTestError });
        if (issueRef) notifyFailed(issueRef, taskId, finalTestError);
        else notifyTaskFailed(taskId, repoName, finalTestError);
        return { taskId, success: false, prUrl: null, error: finalTestError };
      }
    }
    updatePipelineStage(taskId, "test_complete");
    notifyPipelineStage(taskId, repoName, `Tests passed${testResult.attempts > 0 ? ` after ${testResult.attempts} fix attempt(s)` : ""}`);

    // Run integration tests if configured
    console.log(`  Running integration tests...`);
    let integrationResult = await runIntegrationTests(config, repo, taskId, worktree.path, description);
    if (integrationResult.ran) {
      if (!integrationResult.passed) {
        const integrationError = `Integration tests failed after ${integrationResult.attempts} attempt(s)`;

        if (!noDiagnose && !diagnosticAttempted.has("integration_tests") && worktree) {
          diagnosticAttempted.add("integration_tests");
          const diagResult = await runDiagnosticLoop(
            config, repo, taskId, worktree.path, "integration_tests", integrationError, description
          );
          if (diagResult.recovered) {
            console.log(`  Retrying integration tests after diagnosis...`);
            integrationResult = await runIntegrationTests(config, repo, taskId, worktree.path, description);
          }
        }

        if (!integrationResult.passed) {
          const finalIntError = `Integration tests failed after ${integrationResult.attempts} attempt(s)`;
          updateTask(taskId, { status: "failed", error: finalIntError });
          if (issueRef) notifyFailed(issueRef, taskId, finalIntError);
          else notifyTaskFailed(taskId, repoName, finalIntError);
          return { taskId, success: false, prUrl: null, error: finalIntError };
        }
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

      if (!noDiagnose && !diagnosticAttempted.has("browser_validation") && worktree) {
        diagnosticAttempted.add("browser_validation");
        const diagResult = await runDiagnosticLoop(
          config, repo, taskId, worktree.path, "browser_validation", browserError, description
        );
        if (diagResult.recovered) {
          console.log(`  Retrying browser validation after diagnosis...`);
          const retryBrowser = await runBrowserValidation(config, repo, worktree.path);
          if (retryBrowser.ran && retryBrowser.passed) {
            console.log(`  Browser validation passed on retry`);
          } else if (retryBrowser.ran && !retryBrowser.passed) {
            const retryBrowserError = `Browser validation failed after diagnostic retry: ${retryBrowser.output.slice(0, 200)}`;
            updateTask(taskId, { status: "failed", error: retryBrowserError });
            if (issueRef) notifyFailed(issueRef, taskId, retryBrowserError);
            else notifyTaskFailed(taskId, repoName, retryBrowserError);
            return { taskId, success: false, prUrl: null, error: retryBrowserError };
          }
        } else {
          updateTask(taskId, { status: "failed", error: browserError });
          if (issueRef) notifyFailed(issueRef, taskId, browserError);
          else notifyTaskFailed(taskId, repoName, browserError);
          return { taskId, success: false, prUrl: null, error: browserError };
        }
      } else {
        updateTask(taskId, { status: "failed", error: browserError });
        if (issueRef) notifyFailed(issueRef, taskId, browserError);
        else notifyTaskFailed(taskId, repoName, browserError);
        return { taskId, success: false, prUrl: null, error: browserError };
      }
    }
    if (!browserResult.ran) {
      console.log(`  Browser validation skipped: ${browserResult.output}`);
    } else {
      console.log(`  Browser validation passed`);
    }

    // Final check before PR — catches type errors from test quality agent, integration tests, etc.
    if (repo.checkCommand) {
      console.log(`  Final check: ${repo.checkCommand}`);
      try {
        execSync(repo.checkCommand, { cwd: worktree.path, stdio: "pipe" });
        console.log(`  Final check passed`);
      } catch (err) {
        const checkError = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
        console.log(`  Final check FAILED`);
        const finalCheckError = `Final check failed: ${checkError.slice(0, 200)}`;

        if (!noDiagnose && !diagnosticAttempted.has("final_check") && worktree) {
          diagnosticAttempted.add("final_check");
          const diagResult = await runDiagnosticLoop(
            config, repo, taskId, worktree.path, "final_check", finalCheckError, description
          );
          if (diagResult.recovered) {
            console.log(`  Retrying final check after diagnosis...`);
            try {
              execSync(repo.checkCommand!, { cwd: worktree.path, encoding: "utf-8", stdio: "pipe" });
              console.log(`  Final check passed after diagnostic fix`);
            } catch {
              console.log(`  Final check still fails after diagnostic fix`);
              updateTask(taskId, { status: "failed", error: finalCheckError });
              if (issueRef) notifyFailed(issueRef, taskId, finalCheckError);
              else notifyTaskFailed(taskId, repoName, finalCheckError);
              return { taskId, success: false, prUrl: null, error: `Final check failed: ${repo.checkCommand}` };
            }
          } else {
            updateTask(taskId, { status: "failed", error: finalCheckError });
            if (issueRef) notifyFailed(issueRef, taskId, finalCheckError);
            else notifyTaskFailed(taskId, repoName, finalCheckError);
            return { taskId, success: false, prUrl: null, error: `Final check failed: ${repo.checkCommand}` };
          }
        } else {
          updateTask(taskId, { status: "failed", error: finalCheckError });
          if (issueRef) notifyFailed(issueRef, taskId, finalCheckError);
          else notifyTaskFailed(taskId, repoName, finalCheckError);
          return { taskId, success: false, prUrl: null, error: `Final check failed: ${repo.checkCommand}` };
        }
      }
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
      else notifyTaskCompleted(taskId, repoName, gitResult.prUrl);
      console.log(`  PR: ${gitResult.prUrl}`);
      return { taskId, success: true, prUrl: gitResult.prUrl };
    }

    if (gitResult.error) {
      if (!noDiagnose && !diagnosticAttempted.has("commit_push") && worktree) {
        diagnosticAttempted.add("commit_push");
        const diagResult = await runDiagnosticLoop(
          config, repo, taskId, worktree.path, "commit_push", gitResult.error, description
        );
        if (diagResult.recovered) {
          console.log(`  Retrying commit/push after diagnosis...`);
          const retryGit = commitAndPush(repo, worktree, description, reviewSummaryWithTests, targetBranch);
          if (retryGit.prUrl) {
            updatePipelineStage(taskId, "pr_created");
            updateTask(taskId, { status: "completed", pr_url: retryGit.prUrl });
            if (issueRef) notifyPrCreated(issueRef, taskId, retryGit.prUrl);
            else notifyTaskCompleted(taskId, repoName, retryGit.prUrl);
            console.log(`  PR: ${retryGit.prUrl}`);
            return { taskId, success: true, prUrl: retryGit.prUrl };
          }
        }
      }

      updateTask(taskId, {
        status: gitResult.committed ? "partial" : "failed",
        error: gitResult.error,
      });
      if (issueRef) notifyFailed(issueRef, taskId, gitResult.error);
      else notifyTaskFailed(taskId, repoName, gitResult.error);
      return { taskId, success: false, prUrl: null, error: gitResult.error };
    }

    updateTask(taskId, { status: "completed" });
    return { taskId, success: true, prUrl: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    // Run diagnostician on unexpected errors
    if (!noDiagnose && !diagnosticAttempted.has("unexpected_error") && worktree) {
      diagnosticAttempted.add("unexpected_error");
      try {
        const diagResult = await runDiagnosticLoop(
          config, repo, taskId, worktree.path, "unexpected_error", error, description
        );
        if (diagResult.recovered) {
          console.log(`  Diagnostician applied fixes for unexpected error — manual retry recommended`);
        }
      } catch {
        // Best effort — don't let diagnostician errors mask the original error
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
    else notifyTaskFailed(taskId, repoName, error);
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
