import type { YardmasterConfig, RepoConfig } from "../../config.js";
import type { StrategyResult } from "./types.js";
import { runFullDockerStrategy } from "./full-docker.js";
import { runTestSuiteStrategy } from "./test-suite.js";
import { runSmokeStrategy } from "./smoke.js";
import { runSelfExecStrategy } from "./self-exec.js";
import { runAskAgentStrategy } from "./ask-agent.js";

export type { StrategyResult } from "./types.js";

/**
 * Dispatch to the integration strategy declared in repos.json.
 *
 * Integration testing is required, not opt-in: every repo must declare a
 * strategy. Repos with no declaration default to `ask-agent` (see
 * `loadConfig()` in src/config.ts), which halts the pipeline and surfaces
 * a clarification request.
 */
export async function runIntegrationStrategy(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  description: string,
): Promise<StrategyResult> {
  const strategy = repo.integrationStrategy ?? "ask-agent";
  console.log(`    Integration strategy: ${strategy}`);

  switch (strategy) {
    case "full-docker":
      return runFullDockerStrategy(config, repo, taskId, worktreePath, description);
    case "test-suite":
      return runTestSuiteStrategy(repo, worktreePath);
    case "smoke":
      return runSmokeStrategy(repo, worktreePath);
    case "self-exec":
      return runSelfExecStrategy(repo, worktreePath);
    case "ask-agent":
      return runAskAgentStrategy(repo);
    default: {
      // Exhaustiveness guard — unreachable if config validation worked.
      const _exhaustive: never = strategy;
      void _exhaustive;
      return runAskAgentStrategy(repo);
    }
  }
}
