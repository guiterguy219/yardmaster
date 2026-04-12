import type { YardmasterConfig, RepoConfig } from "../../config.js";
import { runIntegrationTests } from "../runner.js";
import type { StrategyResult } from "./types.js";

/**
 * `full-docker` strategy — wraps the existing Docker + agent-written e2e flow
 * in `runIntegrationTests`. Use for repos with services + DB + auth.
 */
export async function runFullDockerStrategy(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  description: string,
): Promise<StrategyResult> {
  const result = await runIntegrationTests(config, repo, taskId, worktreePath, description);
  return {
    ran: result.ran,
    passed: result.passed,
    output: result.output,
    attempts: result.attempts,
    testsWritten: result.testsWritten,
  };
}
