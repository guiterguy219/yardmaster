import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import { INTEGRATION_TEST_SYSTEM_PROMPT, buildIntegrationTestPrompt } from "../prompts/integration-test.js";

export interface IntegrationTestAgentResult {
  wrote: boolean;
  summary: string;
}

const NO_TESTS_NEEDED = "NO_INTEGRATION_TESTS_NEEDED";

export async function runIntegrationTestAgent(
  config: YardmasterConfig,
  repo: RepoConfig,
  diff: string,
  worktreePath: string,
  availableServices: Record<string, string>,
  authStrategy: string | undefined,
): Promise<IntegrationTestAgentResult> {
  const prompt = buildIntegrationTestPrompt(repo, diff, worktreePath, availableServices, authStrategy);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: INTEGRATION_TEST_SYSTEM_PROMPT,
    workingDir: worktreePath,
    allowedTools: ["Bash", "Edit", "Read", "Write", "Glob", "Grep"],
    model: "sonnet",
    timeout: 300_000,
  });

  if (!result.success) {
    return { wrote: false, summary: result.error ?? "Integration test agent failed" };
  }

  if (result.result?.includes(NO_TESTS_NEEDED)) {
    return { wrote: false, summary: result.result };
  }

  return { wrote: true, summary: result.result };
}
