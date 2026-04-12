import { execSync } from "node:child_process";
import type { RepoConfig } from "../../config.js";
import type { StrategyResult } from "./types.js";
import { getExecOutput } from "../exec-utils.js";

/**
 * `test-suite` strategy — for repos with a non-unit test suite (e2e, e2e-lite).
 * Runs `repo.integrationTestCommand` after unit tests have already passed.
 */
export async function runTestSuiteStrategy(
  repo: RepoConfig,
  worktreePath: string,
): Promise<StrategyResult> {
  const cmd = repo.integrationTestCommand;
  if (!cmd) {
    return {
      ran: false,
      passed: false,
      output:
        "test-suite strategy selected but repo.integrationTestCommand is not configured",
      attempts: 0,
      needsClarification: true,
      clarificationQuestions: [
        `What command should run the integration test suite for repo "${repo.name}"? ` +
          `Add it as "integrationTestCommand" in repos.json.`,
      ],
    };
  }

  try {
    const stdout = execSync(cmd, {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 600_000,
    });
    return { ran: true, passed: true, output: stdout, attempts: 1 };
  } catch (err) {
    return { ran: true, passed: false, output: getExecOutput(err), attempts: 1 };
  }
}
