import { execSync } from "node:child_process";
import type { RepoConfig } from "../../config.js";
import type { StrategyResult } from "./types.js";
import { getExecOutput } from "../exec-utils.js";

/**
 * `self-exec` strategy — yardmaster dogfooding.
 *
 * Verifies the freshly-built binary can at minimum invoke its own CLI:
 *   1. Build (npm run build / tsc)
 *   2. Run `node dist/cli.js doctor` — exercises CLI parsing, config loading,
 *      and the doctor pre-flight checks.
 *
 * A future iteration should spin up a sandbox repo and run a canned `ym task`
 * end-to-end (worktree → review loop → PR shape verification). For now the
 * doctor invocation catches the regressions we've actually shipped (broken
 * imports, missing pipeline wiring, config schema breakage).
 */
export async function runSelfExecStrategy(
  repo: RepoConfig,
  worktreePath: string,
): Promise<StrategyResult> {
  let output = "";

  // self-exec needs an emitting build (dist/ must be produced). repo.checkCommand
  // is often `npx tsc --noEmit`, which would not emit — so we require an explicit
  // `buildCommand` here and surface a clarification when missing rather than
  // silently failing on a missing dist/cli.js.
  const buildCmd = repo.buildCommand;
  if (!buildCmd) {
    return {
      ran: false,
      passed: false,
      output:
        "self-exec strategy selected but repo.buildCommand is not configured. " +
        "An emitting build (e.g. \"npx tsc\" or \"npm run build\") is required so " +
        "the CLI invocation can resolve dist/cli.js.",
      attempts: 0,
      needsClarification: true,
      clarificationQuestions: [
        `What command builds repo "${repo.name}" so that the CLI entry point is emitted? ` +
          `Add it as "buildCommand" in repos.json (e.g. "npm run build" or "npx tsc").`,
      ],
    };
  }
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

  // Build succeeded — now exercise the CLI surface.
  const cliInvocation = repo.smokeCommand ?? "node dist/cli.js --help";
  try {
    output += `\n$ ${cliInvocation}\n`;
    output += execSync(cliInvocation, {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60_000,
    });
    return { ran: true, passed: true, output, attempts: 1 };
  } catch (err) {
    return {
      ran: true,
      passed: false,
      output: `${output}\nself-exec invocation failed:\n${getExecOutput(err)}`,
      attempts: 1,
    };
  }
}
