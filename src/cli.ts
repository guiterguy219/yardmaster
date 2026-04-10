import { readFileSync } from "fs";
import { Command } from "commander";
import { executeTask } from "./task-runner.js";
import { getRecentTasks } from "./db.js";
import { checkCapacity } from "./capacity.js";
import { enqueueTask, getQueueContents, removeJob, changePriority, closeQueue } from "./queue/task-queue.js";
import { startWorker, stopWorker } from "./queue/task-worker.js";
import { PRIORITY, PRIORITY_LABELS, parsePriority, type PriorityLevel } from "./queue/constants.js";
import { scanReposForIssues } from "./issue-scanner.js";
import { runDoctor } from "./doctor.js";

const program = new Command();

program
  .name("ym")
  .description("Yardmaster — autonomous agent orchestration")
  .version("0.1.0");

// ── ym task ─────────────────────────────────────────────
// P0 immediate — runs now, bypasses queue
program
  .command("task")
  .description("Run an autonomous coding task immediately (P0)")
  .argument("[description]", "What the agent should do")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--file <path>", "Read task description from a file")
  .action(async (description: string | undefined, opts: { repo: string; file?: string }) => {
    const taskDescription = resolveDescription(description, opts.file);

    console.log(`\nYardmaster — Task (P0 immediate)`);
    console.log(`  Repo: ${opts.repo}`);
    console.log(`  Task: ${taskDescription.slice(0, 100)}${taskDescription.length > 100 ? "..." : ""}\n`);

    const result = await executeTask(opts.repo, taskDescription);

    console.log();
    if (result.success) {
      console.log(`Done. ${result.prUrl ? `PR: ${result.prUrl}` : "Completed (no PR created)"}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  });

// ── ym queue ────────────────────────────────────────────
// Add to queue or show queue contents
const queueCmd = program
  .command("queue")
  .description("Add a task to the queue or show queue contents");

queueCmd
  .command("add")
  .description("Add a task to the queue")
  .argument("[description]", "What the agent should do")
  .requiredOption("--repo <name>", "Target repository name")
  .option("--file <path>", "Read task description from a file")
  .option("--priority <level>", "Priority: urgent, high, normal, low", "normal")
  .action(async (description: string | undefined, opts: { repo: string; file?: string; priority: string }) => {
    const taskDescription = resolveDescription(description, opts.file);
    const priority = parsePriority(opts.priority);
    const label = PRIORITY_LABELS[priority];

    const jobId = await enqueueTask(opts.repo, taskDescription, priority, "manual");
    console.log(`Queued: ${jobId} [${label}] ${opts.repo} — ${taskDescription.slice(0, 80)}`);
    await closeQueue();
  });

queueCmd
  .command("show")
  .description("Show queued tasks")
  .action(async () => {
    const tasks = await getQueueContents();

    if (tasks.length === 0) {
      console.log("Queue is empty.");
      await closeQueue();
      return;
    }

    console.log(`\nQueue (${tasks.length} tasks):\n`);
    for (const t of tasks) {
      const label = PRIORITY_LABELS[t.priority as PriorityLevel] ?? `P${t.priority}`;
      const issue = t.issueRef ? ` (${t.issueRef})` : "";
      const age = formatAge(t.queuedAt);
      console.log(`  [${label}] ${t.id}  ${t.repo}  ${t.description.slice(0, 50)}${issue}  (${age})`);
    }
    console.log();
    await closeQueue();
  });

// ── ym bump ─────────────────────────────────────────────
program
  .command("bump")
  .description("Change a queued task's priority")
  .argument("<jobId>", "Job ID to reprioritize")
  .argument("<priority>", "New priority: urgent, high, normal, low")
  .action(async (jobId: string, priority: string) => {
    const newPriority = parsePriority(priority);
    await changePriority(jobId, newPriority);
    console.log(`Bumped ${jobId} to ${PRIORITY_LABELS[newPriority]}`);
    await closeQueue();
  });

// ── ym remove ───────────────────────────────────────────
program
  .command("remove")
  .description("Remove a task from the queue")
  .argument("<jobId>", "Job ID to remove")
  .action(async (jobId: string) => {
    await removeJob(jobId);
    console.log(`Removed ${jobId}`);
    await closeQueue();
  });

// ── ym worker ───────────────────────────────────────────
program
  .command("worker")
  .description("Start the background worker (processes queue)")
  .action(async () => {
    console.log("Yardmaster worker starting...");
    const worker = startWorker();

    const shutdown = async () => {
      console.log("\nShutting down worker...");
      await stopWorker(worker);
      await closeQueue();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log("Worker running. Press Ctrl+C to stop.\n");
  });

// ── ym scan ─────────────────────────────────────────────
program
  .command("scan")
  .description("Scan all repos for ym-labeled GitHub issues and queue them")
  .action(async () => {
    console.log("Scanning repos for issues...\n");
    const result = await scanReposForIssues();
    console.log(`\nScan complete: ${result.queued} queued, ${result.skipped} skipped`);
    if (result.errors.length > 0) {
      console.log(`Errors:`);
      for (const err of result.errors) {
        console.log(`  - ${err}`);
      }
    }
    await closeQueue();
  });

// ── ym status ───────────────────────────────────────────
program
  .command("status")
  .description("Show recent task history")
  .option("-n, --limit <number>", "Number of tasks to show", "10")
  .action((opts: { limit: string }) => {
    const tasks = getRecentTasks(parseInt(opts.limit, 10));

    if (tasks.length === 0) {
      console.log("No tasks yet.");
      return;
    }

    console.log(`\nRecent tasks:\n`);
    for (const task of tasks) {
      const status = formatStatus(task.status);
      const pr = task.pr_url ? ` -> ${task.pr_url}` : "";
      const err = task.error ? ` (${task.error})` : "";
      console.log(`  ${status} ${task.id}  ${task.repo}  ${task.description.slice(0, 60)}${pr}${err}`);
    }
    console.log();
  });

// ── ym doctor ───────────────────────────────────────────
program
  .command("doctor")
  .description("Run pre-flight checks (git, gh, claude, ssh, redis, repos)")
  .action(async () => {
    const exitCode = await runDoctor();
    process.exit(exitCode);
  });

// ── ym capacity ─────────────────────────────────────────
program
  .command("capacity")
  .description("Check current rate limit capacity")
  .action(() => {
    const cap = checkCapacity();
    console.log(`\nCapacity:`);
    console.log(`  Can proceed: ${cap.canProceed ? "yes" : "NO"}`);
    console.log(`  Using overage: ${cap.isUsingOverage ? "yes" : "no"}`);
    if (cap.resetsAt) {
      console.log(`  Resets at: ${cap.resetsAt.toISOString()}`);
    }
    if (cap.reason) {
      console.log(`  Note: ${cap.reason}`);
    }
    console.log();
  });

// ── helpers ─────────────────────────────────────────────

function resolveDescription(description: string | undefined, filePath?: string): string {
  if (filePath) {
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf-8").trim();
    } catch (err) {
      console.error(`Error: cannot read file '${filePath}': ${(err as NodeJS.ErrnoException).message}`);
      process.exit(1);
    }
    if (!contents.length) {
      console.error(`Error: file '${filePath}' is empty`);
      process.exit(1);
    }
    return contents;
  }
  if (description) return description;
  console.error("Error: provide a task description or use --file <path>");
  process.exit(1);
}

function formatStatus(status: string): string {
  switch (status) {
    case "completed": return "[done]";
    case "running":   return "[....]";
    case "failed":    return "[FAIL]";
    case "partial":   return "[part]";
    case "pending":   return "[wait]";
    default:          return `[${status}]`;
  }
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

program.parse();
