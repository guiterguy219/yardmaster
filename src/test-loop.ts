import { execSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { runCoder } from "./agents/coder.js";

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
      const output = (err as any).stderr?.toString() || (err as any).stdout?.toString() || (err instanceof Error ? err.message : String(err));
      return { passed: false, output };
    }
  }

  console.log(`  Running tests...`);
  let result = runTests();

  if (result.passed) {
    console.log(`  Tests passed`);
    return { passed: true, attempts: 0, output: result.output };
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
      return { passed: true, attempts: attempt, output: result.output };
    }

    console.log(`  Tests FAILED`);
  }

  return { passed: false, attempts: MAX_FIX_ATTEMPTS, output: result.output };
}
