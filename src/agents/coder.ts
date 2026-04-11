import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent, type AgentRunResult } from "../agent-runner.js";
import { CODER_SYSTEM_PROMPT, buildCoderPrompt } from "../prompts/coder.js";
import { createSerenaConfig, cleanupSerenaConfig } from "../serena.js";

export async function runCoder(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskDescription: string,
  worktreePath: string
): Promise<AgentRunResult> {
  const prompt = buildCoderPrompt(repo, taskDescription, worktreePath);

  let mcpConfigPath: string | undefined;
  if (repo.useSerena) {
    try {
      mcpConfigPath = createSerenaConfig(worktreePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create Serena MCP config for ${worktreePath}: ${msg}`);
    }
  }

  try {
    return await runAgent(config, {
      prompt,
      systemPrompt: CODER_SYSTEM_PROMPT,
      workingDir: worktreePath,
      model: "opus",
      timeout: config.timeouts.coder,
      mcpConfigPath,
    });
  } finally {
    if (mcpConfigPath) {
      cleanupSerenaConfig(mcpConfigPath);
    }
  }
}
