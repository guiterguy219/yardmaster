import type { YardmasterConfig, RepoConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import { TEST_QUALITY_SYSTEM_PROMPT, buildTestQualityPrompt } from "../prompts/test-quality.js";

export interface TestQualityResult {
  wrote: boolean;
  summary: string;
}

const NO_TESTS_NEEDED = "NO_TESTS_NEEDED";

export async function runTestQualityAgent(
  config: YardmasterConfig,
  repo: RepoConfig,
  diff: string,
  worktreePath: string
): Promise<TestQualityResult> {
  const prompt = buildTestQualityPrompt(repo, diff, worktreePath);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: TEST_QUALITY_SYSTEM_PROMPT,
    workingDir: worktreePath,
    allowedTools: ["Bash", "Edit", "Read", "Write", "Glob", "Grep"],
    model: "sonnet",
    timeout: 300_000,
  });

  if (!result.success) {
    return { wrote: false, summary: result.error ?? "Test quality agent failed" };
  }

  if (result.result.includes(NO_TESTS_NEEDED)) {
    return { wrote: false, summary: result.result };
  }

  return { wrote: true, summary: result.result };
}
