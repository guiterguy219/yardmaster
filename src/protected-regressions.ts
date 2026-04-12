import { execSync } from "node:child_process";
import type { RepoConfig } from "./config.js";

export interface ProtectedViolation {
  file: string;
  function?: string;
  reason: string;
}

export interface ProtectedRegressionResult {
  ran: boolean;
  violations: ProtectedViolation[];
  reason?: string;
}

/**
 * Compare the worktree's branch against `origin/<baseBranch>` (three-dot, i.e.
 * against the merge-base) and flag changes to files/functions configured as
 * protected on the repo. Designed to surface docker.ts-style regressions where
 * unrelated tasks accidentally rewrite load-bearing infrastructure code.
 *
 * Fail-open: any unexpected error returns `ran: false` so the pipeline is not
 * blocked by a broken safety check.
 */
export function checkProtectedRegressions(
  repo: RepoConfig,
  worktreePath: string,
  baseBranch?: string
): ProtectedRegressionResult {
  const protectedFiles = repo.protectedFiles ?? [];
  const protectedFunctions = repo.protectedFunctions ?? {};

  if (protectedFiles.length === 0 && Object.keys(protectedFunctions).length === 0) {
    return { ran: false, violations: [], reason: "no protected files/functions configured" };
  }

  const baseRef = `origin/${baseBranch ?? repo.defaultBranch}`;

  let changedFiles: string[];
  try {
    const out = execSync(`git diff --name-only ${baseRef}...HEAD`, {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    changedFiles = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    return {
      ran: false,
      violations: [],
      reason: `git diff failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (changedFiles.length === 0) {
    return { ran: true, violations: [] };
  }

  const violations: ProtectedViolation[] = [];
  const protectedFileSet = new Set(protectedFiles);

  for (const file of changedFiles) {
    if (protectedFileSet.has(file)) {
      violations.push({ file, reason: "file is marked protected" });
    }
  }

  for (const [file, fnNames] of Object.entries(protectedFunctions)) {
    if (!changedFiles.includes(file)) continue;

    let fileDiff = "";
    try {
      fileDiff = execSync(`git diff ${baseRef}...HEAD -- ${shellEscape(file)}`, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // If we can't get the per-file diff, skip function-level checks for this file.
      continue;
    }

    for (const fn of fnNames) {
      if (diffTouchesFunction(fileDiff, fn)) {
        violations.push({
          file,
          function: fn,
          reason: `protected function "${fn}" was modified`,
        });
      }
    }
  }

  return { ran: true, violations };
}

/**
 * Heuristic: a function is "touched" if any added/removed line in the diff
 * mentions the function name as an identifier. This is intentionally simple —
 * it catches direct edits and rewrites without trying to fully parse the AST.
 */
function diffTouchesFunction(diff: string, fnName: string): boolean {
  const re = new RegExp(`\\b${escapeRegex(fnName)}\\b`);
  for (const line of diff.split("\n")) {
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      if (re.test(line)) return true;
    }
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function formatViolations(violations: ProtectedViolation[]): string {
  return violations
    .map((v) => (v.function ? `${v.file}::${v.function} — ${v.reason}` : `${v.file} — ${v.reason}`))
    .join("; ");
}
