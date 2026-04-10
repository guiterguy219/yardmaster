import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent, type AgentRunResult } from "../agent-runner.js";
import { CODER_SYSTEM_PROMPT, buildCoderPrompt } from "../prompts/coder.js";

export async function runCoder(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskDescription: string,
  worktreePath: string
): Promise<AgentRunResult> {
  const prompt = buildCoderPrompt(repo, taskDescription, worktreePath);

  return runAgent(config, {
    prompt,
    systemPrompt: CODER_SYSTEM_PROMPT,
    workingDir: worktreePath,
    timeout: config.timeouts.coder,
  });
}
