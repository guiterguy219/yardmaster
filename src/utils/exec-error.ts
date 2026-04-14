/**
 * Typed error extraction for child_process exec failures.
 *
 * `execSync` / `exec` throw an object with `stderr`, `stdout`, `status`, and
 * `message` when the command exits non-zero. Callers previously cast to `any`
 * to reach these fields — this helper provides a single, type-safe extraction
 * point used across the entire pipeline.
 */

export interface ExecError {
  stdout: string;
  stderr: string;
  code: number | null;
  message: string;
}

export function extractExecError(err: unknown): ExecError {
  if (err && typeof err === "object") {
    const e = err as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number;
      code?: number;
      message?: string;
    };
    return {
      stderr: e.stderr ? e.stderr.toString() : "",
      stdout: e.stdout ? e.stdout.toString() : "",
      code: e.status ?? e.code ?? null,
      message: e.message ?? String(err),
    };
  }
  return { stderr: "", stdout: "", code: null, message: String(err) };
}

/**
 * Convenience: extract the most informative output string from an exec error.
 * Prefers stderr (where compiler / test runner output usually lands), falls
 * back to stdout, then the error message.
 */
export function extractExecOutput(err: unknown): string {
  const e = extractExecError(err);
  return e.stderr || e.stdout || e.message;
}
