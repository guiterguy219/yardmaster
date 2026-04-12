/**
 * Protected files / functions guard.
 *
 * After the final diff is computed, this module compares modified files (and
 * specific function signatures within them) against a per-repo allow-list
 * configured via repos.json. The goal is to catch regressions in load-bearing
 * files (e.g. src/integration/docker.ts) introduced by automated coding tasks.
 *
 * Behavior:
 *  - Touching a protected file produces a WARNING (logged, task continues).
 *  - Modifying a protected function signature produces a BLOCK (task fails).
 */

/** Per-repo configuration for the protected-files guard. */
export interface ProtectedFilesConfig {
  protectedFiles?: string[];
  protectedFunctions?: Record<string, string[]>;
}

/** A single guard finding for a touched protected file or function. */
export interface ProtectedFilesIssue {
  file: string;
  function?: string;
  message: string;
}

/** Result of running the guard against a diff. */
export interface ProtectedFilesResult {
  warnings: ProtectedFilesIssue[];
  blocks: ProtectedFilesIssue[];
}

/**
 * Parse `git diff` output to extract the set of modified file paths. Records
 * both the `a/` and `b/` paths so renames into or out of a protected path are
 * detected, and `/dev/null` sentinels (for added/deleted files) are skipped.
 */
export function parseChangedFiles(diff: string): Set<string> {
  const files = new Set<string>();
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match) {
      if (match[1] !== "/dev/null") files.add(match[1]);
      if (match[2] !== "/dev/null") files.add(match[2]);
      continue;
    }
    const renameFrom = line.match(/^rename from (.+)$/);
    if (renameFrom) files.add(renameFrom[1]);
    const renameTo = line.match(/^rename to (.+)$/);
    if (renameTo) files.add(renameTo[1]);
  }
  return files;
}

/**
 * Detect whether the diff modifies the signature of a named function within a
 * specific file. A "signature change" is any added or removed line inside the
 * file's hunks that contains a function declaration for the named function.
 *
 * Recognized declaration patterns (all preceded by `+` or `-`), each anchored
 * to a leading keyword to avoid matching call sites:
 *   - `function <name>(` / `async function <name>(`
 *   - `(export|const|let|var) <name> = (...) =>` / `= function`
 *   - Method declarations inside class bodies, identified by a return-type
 *     annotation or trailing brace (`(...)<: Type>? {`).
 */
export function detectFunctionSignatureChanges(
  diff: string,
  file: string,
  functionNames: string[]
): string[] {
  const changed = new Set<string>();
  const lines = diff.split("\n");

  let inTargetFile = false;
  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      inTargetFile = fileMatch[1] === file || fileMatch[2] === file;
      continue;
    }
    // Handle new-file diffs (`--- /dev/null` / `+++ b/<file>`).
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch && plusMatch[1] === file) {
      inTargetFile = true;
      continue;
    }
    if (!inTargetFile) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    const body = line.slice(1);
    for (const name of functionNames) {
      if (changed.has(name)) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        // function decl: (async )?function name(
        new RegExp(`(^|\\s)(?:async\\s+)?function\\s+${escaped}\\s*[(<]`),
        // const/let/var/export name = (async)? function|(...)=>
        new RegExp(
          `(^|\\s)(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*[:=]`
        ),
        // method declaration inside class/interface: name(...)<: ReturnType>? {
        // Require a `{` at end-of-line (after optional return type) and no
        // preceding `.` (which would indicate a call site like obj.name(...)).
        new RegExp(
          `(^|[^.\\w])${escaped}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$`
        ),
        // arrow assignment: name = (...) =>
        new RegExp(`(^|[^.\\w])${escaped}\\s*=\\s*\\([^)]*\\)\\s*=>`),
      ];
      if (patterns.some((p) => p.test(body))) {
        changed.add(name);
      }
    }
  }

  return Array.from(changed);
}

/**
 * Check the diff against the protected-files configuration. Returns warnings
 * for any touched protected file and blocks for any modified protected
 * function signature.
 */
export function checkProtectedFiles(
  diff: string,
  config: ProtectedFilesConfig
): ProtectedFilesResult {
  const warnings: ProtectedFilesIssue[] = [];
  const blocks: ProtectedFilesIssue[] = [];

  const changedFiles = parseChangedFiles(diff);

  const protectedFiles = new Set<string>(config.protectedFiles ?? []);
  for (const file of changedFiles) {
    if (protectedFiles.has(file)) {
      warnings.push({
        file,
        message: `Protected file modified: ${file}`,
      });
    }
  }

  const protectedFunctions = config.protectedFunctions ?? {};
  for (const [file, names] of Object.entries(protectedFunctions)) {
    if (!changedFiles.has(file)) continue;
    const changed = detectFunctionSignatureChanges(diff, file, names);
    for (const name of changed) {
      blocks.push({
        file,
        function: name,
        message: `Protected function signature changed: ${file}::${name}`,
      });
    }
  }

  return { warnings, blocks };
}
