import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import { TOOLS_AGENT_SYSTEM_PROMPT, buildToolsAgentPrompt } from "../prompts/tools-agent.js";

export async function runToolsAgent(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskDescription: string,
  worktreePath: string
): Promise<string> {
  const prompt = buildToolsAgentPrompt(repo, taskDescription, worktreePath);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: TOOLS_AGENT_SYSTEM_PROMPT,
    workingDir: worktreePath,
    allowedTools: ["Bash", "Read", "Glob", "Grep"],
    model: "haiku",
    timeout: 90_000,
  });

  return result.success ? result.result : "";
}
