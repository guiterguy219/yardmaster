/**
 * Shared helpers for the integration runner and strategy modules.
 */

/**
 * Extract a printable error message from a thrown value (typically a
 * `child_process.execSync` failure). Prefers stderr, then stdout, then
 * `message`, then a String() fallback.
 */
export function getExecOutput(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    if (e.stderr) return e.stderr.toString();
    if (e.stdout) return e.stdout.toString();
    if (e.message) return e.message;
  }
  return String(err);
}
