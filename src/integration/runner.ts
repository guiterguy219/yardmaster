import { execSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "../config.js";
import { loadIntegrationConfig, type IntegrationConfig } from "./config.js";
import { resolveSecrets, buildIntegrationEnv } from "./secrets.js";
import { startServices, stopServices, isDockerAvailable } from "./docker.js";
import { scaffoldIntegrationTests } from "./scaffold.js";
import { runIntegrationTestAgent } from "../agents/integration-test.js";
import { runCoder } from "../agents/coder.js";
import { verifyCheckOrFix } from "../agents/verify-check.js";

const MAX_FIX_ATTEMPTS = 2;

function getExecOutput(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    if (e.stderr) return e.stderr.toString();
    if (e.stdout) return e.stdout.toString();
    if (e.message) return e.message;
  }
  return String(err);
}

export interface IntegrationTestResult {
  ran: boolean;
  passed: boolean;
  testsWritten: boolean;
  output: string;
  attempts: number;
}

export async function runIntegrationTests(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  description: string,
): Promise<IntegrationTestResult> {
  // 1. Load integration config — early-exit before spawning the integration test agent
  //    when there's no config file or the repo has explicitly disabled integration tests.
  //    This avoids a 5-minute agent call (and migration attempts) on repos that have
  //    no integration test infrastructure.
  const integrationConfig = loadIntegrationConfig(repo.name);
  if (!integrationConfig) {
    return { ran: false, passed: true, testsWritten: false, output: "no integration config", attempts: 0 };
  }
  if (!integrationConfig.enabled) {
    return { ran: false, passed: true, testsWritten: false, output: "integration tests disabled", attempts: 0 };
  }

  // 2. Check Docker availability (needed for docker-* services)
  const hasDockerServices = integrationConfig.services
    ? Object.values(integrationConfig.services).some(
        (s) => s.type.startsWith("docker-")
      )
    : false;
  if (hasDockerServices && !isDockerAvailable()) {
    return { ran: false, passed: true, testsWritten: false, output: "Docker not available", attempts: 0 };
  }

  // 3. Resolve secrets (uses cache, prompts if needed)
  const secrets = await resolveSecrets(repo.name, integrationConfig);

  // 4. Build complete env var map
  const integrationEnv = buildIntegrationEnv(repo.name, integrationConfig, secrets);

  // 5. Start Docker services
  let dockerStarted = false;
  if (hasDockerServices) {
    console.log(`    Starting Docker services...`);
    const dockerResult = startServices(repo.name, integrationConfig, secrets);
    if (!dockerResult.started) {
      return { ran: true, passed: false, testsWritten: false, output: `Docker failed: ${dockerResult.error || "unknown error"}`, attempts: 0 };
    }
    dockerStarted = dockerResult.started;
    if (dockerStarted) {
      console.log(`    Docker services ready: ${dockerResult.services.join(", ")}`);
    }
  }

  try {
    // 6. Run migrations against the integration database
    console.log(`    Running migrations...`);
    try {
      execSync("npx typeorm-ts-node-commonjs migration:run -d src/data-source.ts", {
        cwd: worktreePath,
        env: { ...process.env, ...integrationEnv },
        stdio: "pipe",
        timeout: 120_000,
      });
      console.log(`    Migrations complete`);
    } catch (err) {
      const migError = getExecOutput(err);
      console.log(`    Migration warning: ${migError.slice(0, 200)}`);
      // Don't fail — migrations may already be applied on Neon branch
    }

    // 7. Capture diff of task changes BEFORE scaffolding (so scaffold boilerplate isn't included)
    console.log(`    Capturing task diff...`);
    execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
    const diff = execSync("git diff --cached", { cwd: worktreePath, stdio: "pipe" }).toString();

    // 8. Scaffold test utilities (idempotent)
    console.log(`    Scaffolding test utilities...`);
    const scaffold = scaffoldIntegrationTests(repo, integrationConfig);
    if (scaffold.filesCreated.length > 0) {
      console.log(`    Created: ${scaffold.filesCreated.join(", ")}`);
    }

    // 9. Run integration test agent to write tests
    console.log(`    Running integration test agent...`);

    // Pass all integration env vars to the agent (not just hardcoded keys)
    const availableServices: Record<string, string> = { ...integrationEnv };

    let testsWritten = false;
    if (diff.length > 0) {
      const agentResult = await runIntegrationTestAgent(
        config,
        repo,
        diff,
        worktreePath,
        availableServices,
        integrationConfig.auth?.strategy,
      );
      testsWritten = agentResult.wrote;
      console.log(`    Integration test agent: ${agentResult.summary.slice(0, 100)}`);

      if (testsWritten) {
        execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });

        // Verify the integration tests just written type-check before running them.
        // Soft-fail: downstream test invocation and final check gate will catch
        // any remaining errors.
        const checkResult = await verifyCheckOrFix(
          repo,
          worktreePath,
          "integration-test",
          async (errorOutput) => {
            const fixPrompt = `${description}

## Integration Test Type Errors

The integration tests just written produced TypeScript errors when running \`${repo.checkCommand}\`. Fix the test files so the check passes. Prefer fixing the tests; only modify source code if the tests reveal a genuine type bug.

## Check Output

${errorOutput.slice(0, 4000)}`;
            await runCoder(config, repo, fixPrompt, worktreePath);
            execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
          },
        );
        if (!checkResult.passed && !checkResult.skipped) {
          console.log(`    Integration test check still failing after ${checkResult.attempts} attempts — proceeding to test run`);
        }
      }
    }

    // 10. Run integration tests (with fix attempts)
    const testCommand = integrationConfig.testCommand;
    const testTimeout = integrationConfig.testTimeout;

    function runTests(): { passed: boolean; output: string } {
      try {
        const stdout = execSync(testCommand, {
          cwd: worktreePath,
          env: { ...process.env, ...integrationEnv },
          encoding: "utf-8",
          stdio: "pipe",
          timeout: testTimeout,
        });
        return { passed: true, output: stdout };
      } catch (err) {
        return { passed: false, output: getExecOutput(err) };
      }
    }

    console.log(`    Running integration tests...`);
    let testResult = runTests();

    if (testResult.passed) {
      console.log(`    Integration tests passed`);
      return { ran: true, passed: true, testsWritten, output: testResult.output, attempts: 0 };
    }

    console.log(`    Integration tests FAILED`);

    // Fix attempts
    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      console.log(`    Fix attempt ${attempt}/${MAX_FIX_ATTEMPTS}...`);
      const fixPrompt = `${description}

## Integration Test Failures

The integration tests failed. Here is the output:

${testResult.output.slice(0, 4000)}

Fix the code or tests so the integration tests pass. The integration tests run against real services (database, Redis) with mocked auth.`;

      await runCoder(config, repo, fixPrompt, worktreePath);

      console.log(`    Re-running integration tests...`);
      testResult = runTests();

      if (testResult.passed) {
        console.log(`    Integration tests passed after ${attempt} fix attempt(s)`);
        return { ran: true, passed: true, testsWritten, output: testResult.output, attempts: attempt };
      }

      console.log(`    Integration tests FAILED`);
    }

    return { ran: true, passed: false, testsWritten, output: testResult.output, attempts: MAX_FIX_ATTEMPTS };
  } finally {
    // 10. Tear down Docker services
    if (dockerStarted) {
      console.log(`    Stopping Docker services...`);
      stopServices(repo.name);
    }
  }
}
