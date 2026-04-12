import { execSync } from "node:child_process";
import type { RepoConfig } from "../../config.js";
import type { StrategyResult } from "./types.js";
import { getExecOutput } from "../exec-utils.js";

/**
 * `smoke` strategy — for CLI tools and libraries. Runs a build + a single
 * happy-path invocation. A type-check / linter pass is NOT enough to count
 * as integration testing.
 */
export async function runSmokeStrategy(
  repo: RepoConfig,
  worktreePath: string,
): Promise<StrategyResult> {
  const buildCmd = repo.checkCommand ?? "npm run build";
  const smokeCmd = repo.smokeCommand;

  if (!smokeCmd) {
    return {
      ran: false,
      passed: false,
      output: "smoke strategy selected but repo.smokeCommand is not configured",
      attempts: 0,
      needsClarification: true,
      clarificationQuestions: [
        `What single happy-path invocation proves the build works for repo "${repo.name}"? ` +
          `Add it as "smokeCommand" in repos.json (e.g. "node dist/cli.js --help").`,
      ],
    };
  }

  let output = "";
  try {
    output += `$ ${buildCmd}\n`;
    output += execSync(buildCmd, {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 300_000,
    });
  } catch (err) {
    return {
      ran: true,
      passed: false,
      output: `${output}\nbuild failed:\n${getExecOutput(err)}`,
      attempts: 1,
    };
  }

  try {
    output += `\n$ ${smokeCmd}\n`;
    output += execSync(smokeCmd, {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: repo.smokeTimeoutMs ?? 120_000,
    });
    return { ran: true, passed: true, output, attempts: 1 };
  } catch (err) {
    return {
      ran: true,
      passed: false,
      output: `${output}\nsmoke command failed:\n${getExecOutput(err)}`,
      attempts: 1,
    };
  }
}
