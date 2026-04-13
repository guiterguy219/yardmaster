import { execSync } from "node:child_process";
import type { RepoConfig } from "../config.js";
import { extractExecOutput } from "../utils/exec-error.js";

export interface VerifyCheckResult {
  /** True if the check command passed (either initially or after a fix attempt). */
  passed: boolean;
  /** Number of fix attempts made (0 if the initial check passed). */
  attempts: number;
  /** Captured stderr/stdout from the most recent failure, or undefined on success. */
  output?: string;
  /** True if the repo has no check command configured (treated as passed). */
  skipped?: boolean;
}

/**
 * Run the repo's check command (e.g. `tsc --noEmit`). On failure, invoke
 * `fixWith(errorOutput)` to let the caller delegate fixes to a coder agent,
 * then re-run the check. Repeat up to `maxAttempts` times.
 *
 * Every code-writing agent should wrap its completion in this helper so type
 * errors are caught and fixed at the agent boundary, not at the final gate.
 *
 * Returns { passed, attempts, output? }. Caller decides how to handle a
 * failed result (soft-fail and continue, or hard-fail and escalate).
 */
export async function verifyCheckOrFix(
  repo: RepoConfig,
  worktreePath: string,
  agentName: string,
  fixWith: (errorOutput: string) => Promise<void>,
  maxAttempts = 2,
): Promise<VerifyCheckResult> {
  if (!repo.checkCommand) {
    return { passed: true, attempts: 0, skipped: true };
  }

  const checkCommand = repo.checkCommand;
  const runCheck = (): { passed: boolean; output: string } => {
    try {
      execSync(checkCommand, { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" });
      return { passed: true, output: "" };
    } catch (err) {
      return { passed: false, output: extractExecOutput(err) };
    }
  };

  let result = runCheck();
  if (result.passed) {
    return { passed: true, attempts: 0 };
  }

  console.log(`  [${agentName}] Check FAILED — feeding errors back for fix attempt`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await fixWith(result.output);
    result = runCheck();
    if (result.passed) {
      console.log(`  [${agentName}] Check passed after ${attempt} fix attempt(s)`);
      return { passed: true, attempts: attempt };
    }
    console.log(`  [${agentName}] Check still FAILED (attempt ${attempt}/${maxAttempts})`);
  }

  return { passed: false, attempts: maxAttempts, output: result.output };
}
