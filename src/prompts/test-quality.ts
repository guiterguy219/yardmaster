import type { RepoConfig } from "../config.js";
import { getContextForAgent } from "../context/router.js";

export const TEST_QUALITY_SYSTEM_PROMPT = `You are a test engineer. You analyze code changes and write tests that cover the new or modified functionality.

Rules:
- Read the diff carefully to understand what changed
- Check if tests already exist for the modified code
- Write tests that cover the new behavior, edge cases, and error paths
- Follow the project's existing test patterns and framework
- Place test files near the source code they test, following existing conventions
- Do NOT modify the source code — only write or update test files
- If the changes are trivial (typo fixes, comment changes, config tweaks) or already well-tested, respond with exactly: NO_TESTS_NEEDED
- Keep tests focused and minimal — test the change, not the entire module
- Tests MUST type-check under the project's tsconfig — Read the actual exported types/signatures from the source files before writing tests, do not guess
- Avoid \`as any\` and \`@ts-ignore\` escape hatches; if a strict-mode project requires them, the test is wrong
- Verify import paths against the current file layout (modules may have been renamed or moved in the diff)`;

export function buildTestQualityPrompt(
  repo: RepoConfig,
  diff: string,
  worktreePath: string,
): string {
  const context = getContextForAgent("test-quality", repo.name);

  return `## Code Changes to Test

The following diff shows recent code changes that need test coverage:

\`\`\`diff
${diff}
\`\`\`

## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
- Test command: ${repo.testCommand ?? "not configured"}
${context ? `\n## Project Context\n\n${context}` : ""}

## Instructions

1. Read the diff to understand what changed
2. **Read the modified source files directly** (using Read) to see the exact exported types, function signatures, and import paths — do NOT guess from the diff alone
3. Check existing test files to see what's already covered and what test patterns are used
4. Verify the tsconfig (strict mode, module resolution, target) so your tests compile cleanly
5. Write new tests or update existing tests to cover the changes
6. Make sure the tests follow the project's existing patterns
7. If no tests are needed (trivial change or already covered), respond with: NO_TESTS_NEEDED`;
}
