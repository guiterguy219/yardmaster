import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startWorker, stopWorker } from "./task-worker.js";
import { loadConfig } from "../config.js";
import { detectAndMarkInterrupted, recoverInterruptedTasks } from "../recovery.js";
import { removeOrphanedWorktrees } from "../worktree.js";
import { ingestTaskHistory } from "../context/ingest-history.js";

// Load data/.env if it exists (for Telegram tokens, etc.)
try {
  const envPath = join(import.meta.dirname, "..", "..", "data", ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // No .env file — that's fine
}

console.log("Yardmaster worker starting...");

const _config = loadConfig();

console.log("  Scanning for dead workers...");
const _marked = detectAndMarkInterrupted();
console.log(`  ${_marked} task(s) newly marked interrupted`);

console.log("  Recovering interrupted tasks...");
const _recovery = await recoverInterruptedTasks(_config);
console.log(`  Recovered: ${_recovery.recovered}  Failed: ${_recovery.failed}  Skipped: ${_recovery.skipped}`);

console.log("  Cleaning up orphaned worktrees...");
const _gc = removeOrphanedWorktrees(_config);
console.log(`  Removed: ${_gc.removed} worktree(s)`);
for (const err of _gc.errors) {
  console.log(`  Warning: ${err}`);
}

console.log("  Ingesting task history...");
for (const repo of _config.repos) {
  try {
    const result = await ingestTaskHistory(_config, repo.name);
    if (result.insights > 0) {
      console.log(`  History: ${result.insights} insights from ${result.tasksAnalyzed} tasks (${repo.name})`);
    }
  } catch {
    // Best effort
  }
}

const worker = startWorker();

const shutdown = async () => {
  console.log("\nShutting down worker...");
  await stopWorker(worker);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Worker running.");
