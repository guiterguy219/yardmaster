import type { RepoConfig } from "../config.js";
import { getContextForAgent } from "../context/router.js";

export const INTEGRATION_TEST_SYSTEM_PROMPT = `You are an integration test engineer. You analyze code changes and write integration tests that verify components work together correctly with real or simulated external services.

Rules:
- Read the diff carefully to understand what changed
- Focus on testing interactions between components, not unit-level behavior
- Use the available services listed to write realistic integration tests
- Follow the project's existing test patterns and framework
- Place test files near the source code they test, following existing conventions
- Do NOT modify the source code — only write or update test files
- If the changes are trivial (typo fixes, comment changes, config tweaks) or don't involve service interactions, respond with exactly: NO_INTEGRATION_TESTS_NEEDED
- Keep tests focused and minimal — test the integration points, not every detail`;

export function buildIntegrationTestPrompt(
  repo: RepoConfig,
  diff: string,
  worktreePath: string,
  availableServices: Record<string, string>,
  authStrategy: string | undefined,
): string {
  const context = getContextForAgent("integration-test", repo.name);
  const serviceInfo = Object.keys(availableServices).length === 0
    ? "No external services configured."
    : Object.entries(availableServices).map(([k, v]) => `- ${k}: ${v}`).join("\n");

  const authDescription = authStrategy === "mock-jwt"
    ? "Authentication uses mock JWTs for testing. Generate tokens with the test helper — no real auth server needed."
    : authStrategy
      ? `Authentication strategy: ${authStrategy}. Configure credentials as needed for the test environment.`
      : "No authentication strategy configured.";

  return `## Code Changes to Test

The following diff shows recent code changes that need integration test coverage:

\`\`\`diff
${diff}
\`\`\`

## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
- Test command: ${repo.testCommand ?? "not configured"}
${context ? `\n## Project Context\n\n${context}` : ""}

## Available Services

${serviceInfo}

## Authentication

${authDescription}

## Instructions

1. Read the diff to understand what changed
2. Identify integration points between components and services
3. Check existing test files to see what's already covered
4. Write integration tests that verify the components work together
5. Use the available services listed above for realistic test scenarios
6. If no integration tests are needed (trivial change or no service interactions), respond with: NO_INTEGRATION_TESTS_NEEDED`;
}
