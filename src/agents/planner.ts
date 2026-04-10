import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from "../prompts/planner.js";
import { parseAgentJson } from "../utils/parse-json.js";

export interface SubTask {
  description: string;
  files: string[];
  reason: string;
}

export async function runPlanner(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskDescription: string,
  worktreePath: string
): Promise<SubTask[]> {
  const fallback: SubTask[] = [
    { description: taskDescription, files: [], reason: "fallback: could not decompose" },
  ];

  const prompt = buildPlannerPrompt(repo, taskDescription, worktreePath);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    workingDir: worktreePath,
    allowedTools: ["Read", "Glob", "Grep"],
    model: "sonnet",
    timeout: 90_000,
  });

  if (!result.success) return fallback;

  const parsed = parseAgentJson<SubTask[]>(result.result);
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed;
  }
  return fallback;
}
