import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent, type AgentRunResult } from "../agent-runner.js";
import { STYLE_REVIEWER_SYSTEM_PROMPT, buildStyleReviewerPrompt } from "../prompts/style-reviewer.js";

export async function runStyleReviewer(
  config: YardmasterConfig,
  repo: RepoConfig,
  diff: string,
  worktreePath: string
): Promise<AgentRunResult> {
  const prompt = buildStyleReviewerPrompt(repo, diff, worktreePath);

  return runAgent(config, {
    prompt,
    systemPrompt: STYLE_REVIEWER_SYSTEM_PROMPT,
    workingDir: worktreePath,
    timeout: config.timeouts.reviewer,
  });
}
