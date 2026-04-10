import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent, type AgentRunResult } from "../agent-runner.js";
import { LOGIC_REVIEWER_SYSTEM_PROMPT, buildLogicReviewerPrompt } from "../prompts/logic-reviewer.js";

export async function runLogicReviewer(
  config: YardmasterConfig,
  repo: RepoConfig,
  diff: string,
  worktreePath: string,
  priorRoundsContext?: string
): Promise<AgentRunResult> {
  const prompt = buildLogicReviewerPrompt(repo, diff, worktreePath, priorRoundsContext);

  return runAgent(config, {
    prompt,
    systemPrompt: LOGIC_REVIEWER_SYSTEM_PROMPT,
    workingDir: worktreePath,
    model: "opus",
    timeout: config.timeouts.reviewer,
  });
}
