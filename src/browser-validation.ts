import { spawn, execSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { acquireLock, releaseLock, checkMemoryAvailable } from "./resource-lock.js";

export interface BrowserResult {
  ran: boolean;
  passed: boolean;
  output: string;
}

export async function runBrowserValidation(
  _config: YardmasterConfig,
  repo: RepoConfig,
  worktreePath: string
): Promise<BrowserResult> {
  if (!repo.devCommand || !repo.devPort) {
    return { ran: false, passed: true, output: "no dev server configured" };
  }

  const memCheck = checkMemoryAvailable(1500);
  if (!memCheck.available) {
    return { ran: false, passed: true, output: "insufficient memory for browser validation" };
  }

  const lockResult = acquireLock("playwright");
  if (!lockResult.acquired) {
    return { ran: false, passed: true, output: "resource lock held" };
  }

  const readyPattern = repo.readyPattern ?? "ready in";
  const devServer = spawn(repo.devCommand, {
    cwd: worktreePath,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    // Wait for the dev server to become ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Dev server did not become ready within 60s"));
      }, 60_000);

      function checkReady(chunk: Buffer) {
        const text = chunk.toString();
        if (text.includes(readyPattern)) {
          clearTimeout(timeout);
          resolve();
        }
      }

      devServer.stdout?.on("data", checkReady);
      devServer.stderr?.on("data", checkReady);

      devServer.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      devServer.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Dev server exited unexpectedly (code ${code})`));
      });
    });

    // Run Playwright tests
    try {
      const output = execSync("npx playwright test", {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 120_000,
      });
      return { ran: true, passed: true, output };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; stdout?: Buffer | string };
      const output =
        e.stderr?.toString() ||
        e.stdout?.toString() ||
        (err instanceof Error ? err.message : String(err));
      return { ran: true, passed: false, output };
    }
  } finally {
    try {
      process.kill(-devServer.pid!, "SIGTERM");
    } catch {
      // Process may have already exited
    }
    releaseLock("playwright");
  }
}
