import { execSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { runCoder } from "./agents/coder.js";
import { extractExecOutput } from "./utils/exec-error.js";
import { verifyCheckOrFix } from "./agents/verify-check.js";

export interface TestLoopResult {
  passed: boolean;
  attempts: number;
  output: string;
}

export async function runTestLoop(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  description: string
): Promise<TestLoopResult> {
  if (!repo.testCommand) {
    return { passed: true, attempts: 0, output: "no test command configured" };
  }

  const MAX_FIX_ATTEMPTS = 2;

  function runTests(): { passed: boolean; output: string } {
    try {
      const stdout = execSync(repo.testCommand!, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return { passed: true, output: stdout };
    } catch (err) {
      const output = extractExecOutput(err);
      return { passed: false, output };
    }
  }

  // After tests pass, verify the coder's fixes haven't broken the type check.
  // This catches the case where tests pass but production code doesn't compile —
  // previously only caught at the "Final check" gate, too late to re-engage the coder.
  async function verifyTypesAfterTests(attempt: number): Promise<TestLoopResult> {
    const checkResult = await verifyCheckOrFix(
      repo,
      worktreePath,
      "test-loop",
      async (errorOutput) => {
        const fixPrompt = `${description}

## Type Errors After Test Fixes

Tests pass, but the type checker (\`${repo.checkCommand}\`) now fails. Fix the type errors without breaking the passing tests.

## Check Output

${errorOutput.slice(0, 4000)}`;
        await runCoder(config, repo, fixPrompt, worktreePath);
      },
    );
    if (!checkResult.passed && !checkResult.skipped) {
      console.log(`  Tests pass but type check still failing after ${checkResult.attempts} fix attempts`);
    }
    return { passed: true, attempts: attempt, output: result.output };
  }

  console.log(`  Running tests...`);
  let result = runTests();

  if (result.passed) {
    console.log(`  Tests passed`);
    return verifyTypesAfterTests(0);
  }

  console.log(`  Tests FAILED`);

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    const fixPrompt = `${description}

## Test Failures

The tests failed. Here is the output:

${result.output}

Fix the code so the tests pass.`;

    await runCoder(config, repo, fixPrompt, worktreePath);

    console.log(`  Running tests...`);
    result = runTests();

    if (result.passed) {
      console.log(`  Tests passed`);
      return verifyTypesAfterTests(attempt);
    }

    console.log(`  Tests FAILED`);
  }

  return { passed: false, attempts: MAX_FIX_ATTEMPTS, output: result.output };
}
