import type { RepoConfig } from "../../config.js";
import type { StrategyResult } from "./types.js";

/**
 * `ask-agent` strategy — the safe fallback when no integration strategy has
 * been declared for a repo. Halts the pipeline and surfaces a clarification
 * request rather than silently shipping with no integration coverage.
 */
export async function runAskAgentStrategy(repo: RepoConfig): Promise<StrategyResult> {
  return {
    ran: false,
    passed: false,
    output: `INTEGRATION_STRATEGY_UNCLEAR for repo "${repo.name}"`,
    attempts: 0,
    needsClarification: true,
    clarificationQuestions: [
      `Which integration strategy applies to repo "${repo.name}"?`,
      `Options: full-docker | test-suite | smoke | self-exec`,
      `Set "integrationStrategy" in repos.json. See CLAUDE.md > Integration testing for guidance.`,
    ],
  };
}
