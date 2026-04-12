import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import {
  INTEGRATION_ADVISOR_SYSTEM_PROMPT,
  buildIntegrationAdvisorPrompt,
} from "../prompts/integration-advisor.js";

export type IntegrationAdvisorOutcome = "config_created" | "not_applicable" | "failed";

export interface IntegrationAdvisorResult {
  outcome: IntegrationAdvisorOutcome;
  summary: string;
}

const CONFIG_CREATED = "CONFIG_CREATED";
const NOT_APPLICABLE = "NOT_APPLICABLE";

export async function runIntegrationAdvisor(
  config: YardmasterConfig,
  repo: RepoConfig,
  worktreePath: string,
  configPath: string,
  description: string,
): Promise<IntegrationAdvisorResult> {
  const prompt = buildIntegrationAdvisorPrompt(repo, worktreePath, configPath, description);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: INTEGRATION_ADVISOR_SYSTEM_PROMPT,
    workingDir: worktreePath,
    allowedTools: ["Bash", "Read", "Write", "Glob", "Grep"],
    model: "sonnet",
    timeout: 180_000,
  });

  if (!result.success) {
    return { outcome: "failed", summary: result.error ?? "Integration advisor agent failed" };
  }

  const text = result.result ?? "";
  if (text.includes(CONFIG_CREATED)) {
    return { outcome: "config_created", summary: text };
  }
  if (text.includes(NOT_APPLICABLE)) {
    return { outcome: "not_applicable", summary: text };
  }
  return { outcome: "failed", summary: `Advisor returned no decision marker: ${text.slice(0, 200)}` };
}
