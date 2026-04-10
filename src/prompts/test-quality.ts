import type { RepoConfig } from "../config.js";
import { getContextForAgent } from "../context/router.js";

export const TEST_QUALITY_SYSTEM_PROMPT = `You are a senior test engineer specializing in test quality analysis. You evaluate test suites for coverage, correctness, and maintainability.

Rules:
- Assess whether tests actually verify the behavior they claim to test
- Check for common test antipatterns: flaky assertions, over-mocking, testing implementation details
- Verify edge cases and error paths are covered
- Ensure tests are readable and maintainable
- Flag tests that would pass even if the code under test were broken
- Return structured JSON feedback with verdict and issues`;

export function buildTestQualityPrompt(
  repo: RepoConfig,
  taskDescription: string,
  worktreePath: string
): string {
  const context = getContextForAgent('test-quality', repo.name);

  return `## Task

${taskDescription}

## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
${context ? `\n${context}\n` : ""}
## Instructions

Analyze the test quality for the changes described above. Review test coverage, correctness, and adherence to testing best practices.`;
}
