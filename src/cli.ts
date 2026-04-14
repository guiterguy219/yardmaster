import { readFileSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { homedir } from "os";
import { Command } from "commander";
import { executeTask } from "./task-runner.js";
import { loadConfig, getRepo } from "./config.js";
import { getRecentTasks, getTask } from "./db.js";
import { checkCapacity } from "./capacity.js";
import { enqueueTask, getQueueContents, removeJob, changePriority, closeQueue, pauseQueue, resumeQueue, isQueuePaused, getQueue } from "./queue/task-queue.js";
import { startWorker, stopWorker } from "./queue/task-worker.js";
import { PRIORITY, PRIORITY_LABELS, parsePriority, type PriorityLevel } from "./queue/constants.js";
import { scanReposForIssues } from "./issue-scanner.js";
import { runDoctor } from "./doctor.js";
import { onboardRepo } from "./onboarding.js";
import { takeoverPr } from "./pr-takeover.js";
import { detectAndMarkInterrupted, recoverInterruptedTasks } from "./recovery.js";
import { removeOrphanedWorktrees, preserveBranchName } from "./worktree.js";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { ingestRepo } from "./ingestor.js";
import { ingestDocs, searchDocsUrls, pruneStaleDocEntries, type DocsIngestResult } from "./context/ingest-docs.js";
import { purgeStaleWebDocs } from "./context/maintenance.js";
import { ingestTaskHistory } from "./context/ingest-history.js";
import { listContext, getContext, getContextById, searchContext, type ContextKind } from "./context-store.js";
import { getContextStats, ALL_AGENT_ROLES } from "./context/router.js";

function printIngestResult(result: DocsIngestResult): void {
  console.log(`\nDocs ingestion complete:`);
  console.log(`  URLs processed: ${result.urlsProcessed}`);
  console.log(`  URLs changed:   ${result.urlsChanged}`);
  console.log(`  Chunks upserted: ${result.chunksUpserted}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const err of result.errors) {
      console.log(`    - ${err}`);
    }
  }
  console.log();
}

function parseDays(raw: string): number {
  const days = parseInt(raw, 10);
  if (Number.isNaN(days) || days < 1) {
    console.error("Error: --days must be a positive number");
    process.exit(1);
  }
  return days;
}

const program = new Command();

program
  .name("ym")
  .description("Yardmaster — autonomous agent orchestration")
  .version("0.1.0");

// ── ym task ─────────────────────────────────────────────
// P0 immediate — runs now, bypasses queue
program
  .command("task")
  .description("Run an autonomous coding task immediately (P0), bypassing the queue. Runs the full pipeline: planner → coder → style/logic reviewers → check command → tests → PR creation. Use --file for complex multi-paragraph specs.")
  .argument("[description]", "What the agent should do")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--file <path>", "Read task description from a file (recommended for complex, multi-paragraph specs)")
  .option("--no-diagnose", "Skip the diagnostician agent on failure")
  .action(async (description: string | undefined, opts: { repo: string; file?: string; diagnose: boolean }) => {
    const taskDescription = resolveDescription(description, opts.file);

    console.log(`\nYardmaster — Task (P0 immediate)`);
    console.log(`  Repo: ${opts.repo}`);
    console.log(`  Task: ${taskDescription.slice(0, 100)}${taskDescription.length > 100 ? "..." : ""}\n`);

    const config = loadConfig();
    const repo = getRepo(config, opts.repo);

    detectAndMarkInterrupted();
    const recovery = await recoverInterruptedTasks(config);
    if (recovery.recovered > 0 || recovery.failed > 0) {
      console.log(`  Recovery: ${recovery.recovered} recovered, ${recovery.failed} failed, ${recovery.skipped} skipped\n`);
    }

    if (!repo.checkCommand) {
      const onboarding = await onboardRepo(repo.localPath, repo.name);
      const d = onboarding.detection;
      console.log(`Onboarding: no checkCommand configured for "${repo.name}"`);
      console.log(`  Language:        ${d.language}`);
      if (d.packageManager) {
        console.log(`  Package manager: ${d.packageManager}`);
      }
      console.log(`  Has CI:          ${d.hasCI ? "yes" : "no"}`);
      console.log(`  Has Docker:      ${d.hasDocker ? "yes" : "no"}`);
      console.log(`  Has CLAUDE.md:   ${d.hasClaude ? "yes" : "no"}`);
      if (d.checkCommand) {
        console.log(`  Inferred check:  ${d.checkCommand}`);
      }
      if (onboarding.suggestions.length > 0) {
        console.log(`\nSuggestions:`);
        for (const s of onboarding.suggestions) {
          console.log(`  - ${s}`);
        }
      }
      if (d.checkCommand) {
        console.log(`\nTo persist, add to repos.json for "${repo.name}":`);
        console.log(`  "checkCommand": "${d.checkCommand}"`);
      }
      console.log();
    }

    const result = await executeTask(opts.repo, taskDescription, {
      noDiagnose: !opts.diagnose,
    });

    console.log();
    if (result.success) {
      console.log(`Done. ${result.prUrl ? `PR: ${result.prUrl}` : "Completed (no PR created)"}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  });

// ── ym pr ───────────────────────────────────────────────
// Take over an existing PR
program
  .command("pr")
  .description("Take over an existing GitHub PR — branches from its head, applies review feedback and improvements, then creates a new PR targeting the feature branch.")
  .argument("<url>", "GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)")
  .option("--description <text>", "Additional context or instructions to pass to the agent")
  .action(async (url: string, opts: { description?: string }) => {
    console.log(`\nYardmaster — PR Takeover`);
    console.log(`  PR: ${url}\n`);

    const config = loadConfig();

    detectAndMarkInterrupted();
    const recovery = await recoverInterruptedTasks(config);
    if (recovery.recovered > 0 || recovery.failed > 0) {
      console.log(`  Recovery: ${recovery.recovered} recovered, ${recovery.failed} failed, ${recovery.skipped} skipped\n`);
    }

    const result = await takeoverPr(url);

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
  .description("Add tasks to the background queue or inspect its contents. A worker must be running ('ym worker') to process queued tasks.");

queueCmd
  .command("add")
  .description("Add a coding task to the background queue for async processing by 'ym worker'. Priority defaults to 'normal'; use 'urgent' or 'high' to jump the line.")
  .argument("[description]", "What the agent should do")
  .requiredOption("--repo <name>", "Target repository name")
  .option("--file <path>", "Read task description from a file")
  .option("--priority <level>", "Task priority: urgent (P1), high (P2), normal (P3, default), or low (P4)", "normal")
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
  .description("Display all queued tasks ordered by priority, showing job ID, repo, description snippet, and how long each has been waiting.")
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
      const stateTag = t.state === "active" ? " [RUNNING]" : "";
      console.log(`  [${label}]${stateTag} ${t.id}  ${t.repo}  ${t.description.slice(0, 50)}${issue}  (${age})`);
    }
    console.log();
    await closeQueue();
  });

// ── ym bump ─────────────────────────────────────────────
program
  .command("bump")
  .description("Reprioritize a queued task to a new priority level (urgent, high, normal, low). The task must still be waiting in the queue.")
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
  .description("Remove a task from the queue before it is processed. Has no effect on tasks that are already running.")
  .argument("<jobId>", "Job ID to remove")
  .action(async (jobId: string) => {
    await removeJob(jobId);
    console.log(`Removed ${jobId}`);
    await closeQueue();
  });

// ── ym worker ───────────────────────────────────────────
program
  .command("worker")
  .description("Start the background task worker, which processes queued tasks in priority order. Runs until Ctrl+C; use with a process manager (e.g. systemd) for persistent operation.")
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

// ── ym drain / ym resume ────────────────────────────────
program
  .command("drain")
  .description("Pause the queue: workers finish their current job but stop picking up new ones. State persists in Redis until 'ym resume'. Use --all to also abort the active job (best-effort: marks active jobs failed; the worker subprocess may still complete).")
  .option("--all", "Also abort any currently-running job (best-effort)", false)
  .action(async (opts: { all: boolean }) => {
    await pauseQueue();
    console.log("Queue paused. Workers will finish current jobs but pick up no new ones.");

    if (opts.all) {
      const queue = getQueue();
      const active = await queue.getJobs(["active"]);
      if (active.length === 0) {
        console.log("No active jobs to abort.");
      } else {
        for (const job of active) {
          try {
            await job.moveToFailed(new Error("Aborted by ym drain --all"), "ym-drain", false);
            console.log(`  Aborted active job ${job.id}`);
          } catch (err) {
            console.log(`  Failed to abort job ${job.id}: ${(err as Error).message}`);
          }
        }
        console.log("Note: the worker subprocess running the aborted job may continue until it completes its current step.");
      }
    }

    await closeQueue();
  });

program
  .command("resume")
  .description("Resume the queue after 'ym drain'. Workers will start picking up jobs again.")
  .action(async () => {
    const wasPaused = await isQueuePaused();
    await resumeQueue();
    if (wasPaused) {
      console.log("Queue resumed. Workers will pick up jobs again.");
    } else {
      console.log("Queue was not paused; nothing to do.");
    }
    await closeQueue();
  });

// ── ym scan ─────────────────────────────────────────────
program
  .command("scan")
  .description("Scan all configured GitHub repos for open issues labeled 'ym*' and enqueue them as tasks. Skips issues that are already queued or completed.")
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
  .description("Show recent task history with outcomes (done, failed, partial) and PR URLs. Defaults to the last 10 tasks; use -n to show more.")
  .option("-n, --limit <number>", "Number of recent tasks to display (default: 10)", "10")
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
  .description("Validate all prerequisites: git, gh CLI, claude CLI, SSH keys, Redis connectivity, and repos.json entries. Exits non-zero if any check fails.")
  .action(async () => {
    const exitCode = await runDoctor();
    process.exit(exitCode);
  });

// ── ym worker-status ────────────────────────────────────
program
  .command("worker-status")
  .description("Show the current state of the yardmaster systemd service, Redis connection, queue depth, and the most recent task outcome.")
  .action(async () => {
    // systemd service status
    let serviceStatus: string;
    {
      const result = spawnSync("systemctl", ["is-active", "yardmaster"], {
        timeout: 3000,
        killSignal: "SIGTERM",
        encoding: "utf8",
      });
      serviceStatus = result.error ? "not running" : ((result.stdout as string).trim() || "not running");
    }

    // Redis status
    let redisStatus: string;
    try {
      const pong = execSync("redis-cli ping", { timeout: 3000 }).toString().trim();
      redisStatus = pong === "PONG" ? "ok" : pong;
    } catch {
      redisStatus = "unavailable";
    }

    // Queue depth and last task — always close queue connection
    let queueDepth: number | string = 0;
    let last: ReturnType<typeof getRecentTasks>[number] | undefined;
    try {
      const queue = await getQueueContents();
      queueDepth = queue.length;
      const recent = getRecentTasks(1);
      last = recent[0];
    } catch {
      queueDepth = "unavailable";
    } finally {
      await closeQueue();
    }

    console.log(`\nWorker status:`);
    console.log(`  Service:     ${serviceStatus}`);
    console.log(`  Redis:       ${redisStatus}`);
    console.log(`  Queue depth: ${queueDepth}`);
    if (last) {
      const pr = last.pr_url ? ` -> ${last.pr_url}` : "";
      const err = last.error ? ` (${last.error})` : "";
      console.log(`  Last task:   ${formatStatus(last.status)} ${last.repo}  ${(last.description ?? "").slice(0, 60)}${pr}${err}`);
    } else {
      console.log(`  Last task:   none`);
    }
    console.log();
  });

// ── ym recover ──────────────────────────────────────────
program
  .command("recover [taskId]")
  .description("Detect tasks whose worker processes have died, mark them interrupted, and attempt to resume them. Use --gc to also remove orphaned worktrees for finished tasks. If <taskId> is given, fetch its preserved `ym-failed/<taskId>` branch into a fresh worktree for inspection.")
  .option("--gc", "Also remove orphaned worktrees left behind by completed or failed tasks")
  .option("--repo <name>", "Repo to recover from (required when <taskId> isn't found in the local DB)")
  .action(async (taskId: string | undefined, opts: { gc?: boolean; repo?: string }) => {
    const config = loadConfig();

    if (taskId) {
      await recoverPreservedTask(config, taskId, opts.repo);
      return;
    }

    console.log("\nYardmaster — Recovery\n");

    // Step 1: detect running tasks whose worker PIDs are dead
    console.log("Scanning for dead workers...");
    const marked = detectAndMarkInterrupted();
    console.log(`  ${marked} task(s) newly marked interrupted\n`);

    // Step 2: recover interrupted tasks
    console.log("Recovering interrupted tasks...");
    const { recovered, failed, skipped } = await recoverInterruptedTasks(config);
    console.log(`  Recovered: ${recovered}  Failed: ${failed}  Skipped: ${skipped}\n`);

    // Step 3: GC orphaned worktrees (opt-in)
    if (opts.gc) {
      console.log("Cleaning up orphaned worktrees...");
      const { removed, errors } = removeOrphanedWorktrees(config);
      console.log(`  Removed: ${removed} worktree(s)`);
      for (const err of errors) {
        console.log(`  Warning: ${err}`);
      }
      console.log();
    }
  });

async function recoverPreservedTask(
  config: ReturnType<typeof loadConfig>,
  taskId: string,
  repoOverride?: string
): Promise<void> {
  const branch = preserveBranchName(taskId);

  let repoName = repoOverride;
  if (!repoName) {
    const task = getTask(taskId);
    if (task) repoName = task.repo;
  }
  if (!repoName) {
    console.error(`Error: task ${taskId} not found in local DB. Pass --repo <name> to specify which repo to fetch from.`);
    process.exit(1);
  }

  const repo = getRepo(config, repoName);

  console.log(`\nYardmaster — Recover preserved task ${taskId}`);
  console.log(`  Repo:   ${repo.name}`);
  console.log(`  Branch: ${branch}\n`);

  // Fetch the preservation branch from origin
  console.log(`Fetching origin/${branch}...`);
  try {
    // Force-update local branch in case a stale local copy exists from a prior recover attempt.
    execSync(`git fetch origin "+${branch}:${branch}"`, {
      cwd: repo.localPath,
      stdio: "pipe",
    });
  } catch (err) {
    console.error(
      `Error: could not fetch ${branch} from origin: ${err instanceof Error ? err.message : String(err)}`
    );
    console.error(`The preservation branch may not exist remotely. Check: git ls-remote origin "${branch}"`);
    process.exit(1);
  }

  // Create a fresh worktree from the preserved branch. If a previous recover
  // invocation left behind a worktree directory or branch, append a timestamp
  // suffix so we don't collide.
  mkdirSync(config.worktreeBaseDir, { recursive: true });
  const baseSuffix = `${taskId}-recovered`;
  let suffix = baseSuffix;
  let worktreePath = join(config.worktreeBaseDir, suffix);
  let recoveryBranch = `ym-recovered/${taskId}`;
  if (existsSync(worktreePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    suffix = `${baseSuffix}-${stamp}`;
    worktreePath = join(config.worktreeBaseDir, suffix);
    recoveryBranch = `ym-recovered/${taskId}-${stamp}`;
    console.log(
      `  Note: ${baseSuffix} already exists; using ${suffix} instead. Remove the old worktree manually if no longer needed.`
    );
  }

  console.log(`Creating worktree at ${worktreePath} on branch ${recoveryBranch}...`);
  try {
    execSync(
      `git worktree add "${worktreePath}" -b "${recoveryBranch}" "${branch}"`,
      { cwd: repo.localPath, stdio: "pipe" }
    );
  } catch (err) {
    console.error(
      `Error: could not create worktree: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  console.log(`\nRecovered preserved work for ${taskId}.`);
  console.log(`  Worktree: ${worktreePath}`);
  console.log(`  Branch:   ${recoveryBranch} (based on ${branch})`);
  console.log(`\nInspect, resume, or open a PR from ${worktreePath}.\n`);
}

// ── shared ingest helper ───────────────────────────────
async function runIngest(repoName: string): Promise<void> {
  const config = loadConfig();
  const repo = getRepo(config, repoName);

  console.log(`\nYardmaster — Ingest context`);
  console.log(`  Repo: ${repo.name}`);
  console.log(`  Path: ${repo.localPath}\n`);

  const result = await ingestRepo(config, repo.name, repo.localPath);

  console.log(`\nIngest complete:`);
  console.log(`  Files scanned:    ${result.filesScanned}`);
  console.log(`  Files changed:    ${result.filesChanged}`);
  console.log(`  Chunks upserted:  ${result.chunksUpserted}`);
  console.log(`  Deps upserted:    ${result.depsUpserted}`);
  if (result.errors.length > 0) {
    console.log(`  Errors:`);
    for (const err of result.errors) {
      console.log(`    - ${err}`);
    }
  }
  console.log();
}

// ── ym ingest ──────────────────────────────────────────
program
  .command("ingest")
  .description("Scan a repo's CLAUDE.md and config files and store the extracted context in the context store, making it available to all agents.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .action(async (opts: { repo: string }) => {
    await runIngest(opts.repo);
  });

// ── ym context ─────────────────────────────────────────
const contextCmd = program
  .command("context")
  .description("Inspect and manage the per-repo context store used to give agents project-specific knowledge.");

contextCmd
  .command("search")
  .description("Full-text search the context store for entries matching a keyword, with optional kind filter (file, dependency, convention, snippet, note).")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .argument("<query>", "Search term to match against key and content")
  .option("--kind <kind>", "Restrict results to a specific entry kind: file, dependency, convention, snippet, or note")
  .action((query: string, opts: { repo: string; kind?: string }) => {
    const kind = opts.kind as ContextKind | undefined;
    const escapedQuery = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const entries = searchContext(opts.repo, escapedQuery, kind);

    if (entries.length === 0) {
      console.log(`No context entries matching "${query}" for ${opts.repo}.`);
      return;
    }

    console.log(`\nFound ${entries.length} entries matching "${query}":\n`);
    for (const entry of entries) {
      const roles = entry.agentRoles.length > 0 ? entry.agentRoles.join(", ") : "all";
      const preview = entry.content.slice(0, 80).replace(/\n/g, " ");
      console.log(`  [${entry.kind}] ${entry.key}`);
      console.log(`    id: ${entry.id}  roles: ${roles}`);
      console.log(`    ${preview}${entry.content.length > 80 ? "..." : ""}`);
    }
    console.log();
  });

contextCmd
  .command("lookup")
  .description("Retrieve a single context entry by numeric ID, or by the combination of --repo, --kind, and --key.")
  .option("--id <id>", "Lookup by entry ID")
  .option("--repo <name>", "Repository name")
  .option("--kind <kind>", "Entry kind: file, dependency, convention, snippet, note")
  .option("--key <key>", "Entry key")
  .action((opts: { id?: string; repo?: string; kind?: string; key?: string }) => {
    let entry;

    if (opts.id) {
      const id = parseInt(opts.id, 10);
      if (Number.isNaN(id)) {
        console.error("Error: --id must be a number");
        process.exit(1);
      }
      entry = getContextById(id);
    } else if (opts.repo && opts.kind && opts.key) {
      entry = getContext(opts.repo, opts.kind as ContextKind, opts.key);
    } else {
      console.error("Error: provide --id or all of --repo, --kind, and --key");
      process.exit(1);
    }

    if (!entry) {
      console.log("No matching context entry found.");
      return;
    }

    const roles = entry.agentRoles.length > 0 ? entry.agentRoles.join(", ") : "all";
    console.log(`\n  ID:      ${entry.id}`);
    console.log(`  Repo:    ${entry.repo}`);
    console.log(`  Kind:    ${entry.kind}`);
    console.log(`  Key:     ${entry.key}`);
    console.log(`  Roles:   ${roles}`);
    console.log(`  Hash:    ${entry.contentHash.slice(0, 12)}...`);
    console.log(`  Created: ${entry.createdAt}`);
    console.log(`  Updated: ${entry.updatedAt}`);
    console.log(`\n--- Content ---\n${entry.content}\n`);
  });

contextCmd
  .command("ingest")
  .description("Scan a repo's CLAUDE.md and config files and store the extracted context in the context store, making it available to all agents.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .action(async (opts: { repo: string }) => {
    await runIngest(opts.repo);
  });

contextCmd
  .command("ingest-docs")
  .description("Fetch one or more documentation URLs, chunk them, and store the content in the context store under the given library name.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .requiredOption("--lib <name>", "Library name (used as key prefix, e.g. 'zod')")
  .argument("<urls...>", "One or more documentation URLs to ingest")
  .action(async (urls: string[], opts: { repo: string; lib: string }) => {
    const config = loadConfig();
    const repo = getRepo(config, opts.repo);

    console.log(`\nIngesting docs for "${opts.lib}" into ${opts.repo} context store`);
    console.log(`  URLs: ${urls.length}\n`);

    const result = await ingestDocs(config, opts.repo, opts.lib, urls, repo.localPath);
    printIngestResult(result);
  });

contextCmd
  .command("prune-docs")
  .description("Remove doc entries older than N days from the context store (default: 30 days). Use this to evict outdated library docs.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--days <n>", "Remove entries older than this many days (default: 30)", "30")
  .action((opts: { repo: string; days: string }) => {
    const days = parseDays(opts.days);

    const removed = pruneStaleDocEntries(opts.repo, days);
    console.log(`\nPruned ${removed} stale doc entries (older than ${days} days) for ${opts.repo}.\n`);
  });

contextCmd
  .command("docs")
  .description("Web-search for documentation pages matching the query, then fetch, chunk, and store them. Combines 'ym context ingest-docs' with automatic URL discovery.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .requiredOption("--lib <name>", "Library name (used as key prefix, e.g. 'zod')")
  .argument("<query>", "Search query to find documentation pages")
  .action(async (query: string, opts: { repo: string; lib: string }) => {
    const config = loadConfig();
    const repo = getRepo(config, opts.repo);

    console.log(`\nSearching for "${opts.lib}" docs: ${query}`);

    const urls = await searchDocsUrls(config, query, opts.lib, repo.localPath);

    if (urls.length === 0) {
      console.log(`  No documentation URLs found for "${query}".`);
      console.log(`  Try providing URLs directly with: ym context ingest-docs --repo ${opts.repo} --lib ${opts.lib} <urls...>\n`);
      return;
    }

    console.log(`  Found ${urls.length} documentation URLs:`);
    for (const url of urls) {
      console.log(`    - ${url}`);
    }
    console.log();

    const result = await ingestDocs(config, opts.repo, opts.lib, urls, repo.localPath);
    printIngestResult(result);
  });

contextCmd
  .command("purge")
  .description("Remove stale web doc entries and their raw content hashes from the context store. More thorough than prune-docs; also cleans up orphaned hash records.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--days <n>", "Remove entries older than this many days (default: 30)", "30")
  .action((opts: { repo: string; days: string }) => {
    const days = parseDays(opts.days);

    const result = purgeStaleWebDocs(opts.repo, days);
    console.log(`\nPurged stale web docs for ${opts.repo} (older than ${days} days):`);
    console.log(`  Doc entries removed:  ${result.entriesRemoved}`);
    console.log(`  Raw hashes removed:   ${result.rawHashesRemoved}`);
    console.log();
  });

contextCmd
  .command("stats")
  .description("Show how much of each agent role's context budget is in use, broken down by entry kind and fill percentage.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .action((opts: { repo: string }) => {
    const roles = ALL_AGENT_ROLES;
    const entries = listContext(opts.repo);

    console.log(`\nContext stats for ${opts.repo}:\n`);

    // Entry breakdown by kind
    const kindCounts = new Map<string, number>();
    for (const entry of entries) {
      kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + 1);
    }
    console.log(`  Total entries: ${entries.length}`);
    for (const [kind, count] of kindCounts) {
      console.log(`    ${kind}: ${count}`);
    }

    // Per-role budget stats
    console.log(`\n  Budget usage by role:\n`);
    console.log(`  ${"Role".padEnd(18)} ${"Budget".padStart(7)} ${"Used".padStart(7)} ${"Entries".padStart(8)}  Fill`);
    console.log(`  ${"─".repeat(18)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(8)}  ${"─".repeat(5)}`);

    for (const role of roles) {
      const stats = getContextStats(role, opts.repo);
      const pct = stats.budget > 0 ? Math.round((stats.formattedLength / stats.budget) * 100) : 0;
      const bar = pct > 90 ? "██▓" : pct > 50 ? "██░" : pct > 0 ? "█░░" : "░░░";
      console.log(
        `  ${role.padEnd(18)} ${String(stats.budget).padStart(7)} ${String(stats.formattedLength).padStart(7)} ${String(stats.entriesAvailable).padStart(8)}  ${bar} ${pct}%`
      );
    }
    console.log();
  });

contextCmd
  .command("history")
  .description("Analyze completed task history for a repo and store extracted patterns and insights into the context store for future tasks.")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .action(async (opts: { repo: string }) => {
    const config = loadConfig();
    getRepo(config, opts.repo); // validate repo exists

    console.log(`\nAnalyzing task history for ${opts.repo}...`);
    const result = await ingestTaskHistory(config, opts.repo);

    if (result.insights === 0 && result.tasksAnalyzed === 0) {
      console.log(`No new tasks to analyze for ${opts.repo}.\n`);
      return;
    }

    if (result.insights === 0) {
      console.log(`Analyzed ${result.tasksAnalyzed} tasks but extracted no insights.\n`);
      return;
    }

    console.log(`Analyzed ${result.tasksAnalyzed} tasks for ${opts.repo}`);
    console.log(`Stored ${result.insights} insights.`);

    // Show the stored insights
    const entries = searchContext(opts.repo, "history:");
    for (const entry of entries) {
      if (entry.key === "history:last-analyzed") continue;
      const preview = entry.content.slice(0, 60).replace(/\n/g, " ");
      console.log(`  - ${entry.key} — ${preview}${entry.content.length > 60 ? "..." : ""}`);
    }
    console.log();
  });

contextCmd
  .command("maintenance")
  .description("Run all context maintenance tasks: purge stale web docs and ingest task history insights. Runs across all repos if --repo is omitted.")
  .option("--repo <name>", "Target a single repository; omit to run maintenance across all configured repos")
  .action(async (opts: { repo?: string }) => {
    const config = loadConfig();
    const repos = opts.repo
      ? [getRepo(config, opts.repo)]
      : config.repos;

    console.log(`\nRunning context maintenance...\n`);

    // Step 1: purge stale web docs
    for (const repo of repos) {
      const purgeResult = purgeStaleWebDocs(repo.name);
      if (purgeResult.entriesRemoved > 0 || purgeResult.rawHashesRemoved > 0) {
        console.log(`  Purge (${repo.name}): ${purgeResult.entriesRemoved} doc entries, ${purgeResult.rawHashesRemoved} raw hashes removed`);
      } else {
        console.log(`  Purge (${repo.name}): nothing to purge`);
      }
    }

    // Step 2: ingest task history
    for (const repo of repos) {
      try {
        const historyResult = await ingestTaskHistory(config, repo.name);
        if (historyResult.insights > 0) {
          console.log(`  History (${repo.name}): ${historyResult.insights} insights from ${historyResult.tasksAnalyzed} tasks`);
        } else if (historyResult.tasksAnalyzed > 0) {
          console.log(`  History (${repo.name}): analyzed ${historyResult.tasksAnalyzed} tasks, no new insights`);
        } else {
          console.log(`  History (${repo.name}): no new tasks to analyze`);
        }
      } catch {
        console.log(`  History (${repo.name}): failed (best effort)`);
      }
    }

    console.log(`\nMaintenance complete.\n`);
  });

// ── ym integration ─────────────────────────────────────
const integrationCmd = program
  .command("integration")
  .description("Manage Docker-based integration test infrastructure for a repo (setup, start/stop services, run tests).");

integrationCmd
  .command("setup")
  .description("Interactive first-time setup: prompt for secrets, start Docker services, and scaffold test utility files for the repo's integration suite.")
  .requiredOption("--repo <name>", "Repository name")
  .action(async (opts: { repo: string }) => {
    const config = loadConfig();
    const repo = getRepo(config, opts.repo);
    const { loadIntegrationConfig } = await import("./integration/config.js");
    const { resolveSecrets } = await import("./integration/secrets.js");
    const { startServices, isDockerAvailable } = await import("./integration/docker.js");
    const { scaffoldIntegrationTests } = await import("./integration/scaffold.js");
    const { ensureKeycloakImage } = await import("./integration/keycloak.js");

    const integrationConfig = loadIntegrationConfig(repo.name);
    if (!integrationConfig) {
      console.error(`No integration config found for ${repo.name}`);
      console.error(`Create data/integration/${repo.name}.yml first`);
      process.exit(1);
    }

    console.log(`\nIntegration setup for ${repo.name}\n`);

    // Build Keycloak image if needed
    const hasKeycloak = Object.values(integrationConfig.services).some(
      (s) => s.type === "docker-keycloak"
    );
    if (hasKeycloak) {
      console.log("Ensuring Keycloak Docker image...");
      const kcSvc = Object.values(integrationConfig.services).find(
        (s) => s.type === "docker-keycloak"
      );
      const clonePath = kcSvc?.build?.clonePath?.replace("~", homedir());
      const kcResult = ensureKeycloakImage(clonePath);
      if (!kcResult.ready) {
        console.error(`  Failed to build Keycloak image: ${kcResult.error}`);
        process.exit(1);
      }
      console.log("  Keycloak image ready\n");
    }

    // Prompt for secrets
    console.log("Resolving secrets...");
    const secrets = await resolveSecrets(repo.name, integrationConfig);
    console.log(`  ${Object.keys(secrets).length} secrets resolved\n`);

    // Start Docker services
    const hasDocker = integrationConfig.services
      ? Object.values(integrationConfig.services).some((s) => s.type.startsWith("docker-"))
      : false;
    if (hasDocker) {
      if (!isDockerAvailable()) {
        console.error("Docker is not available. Install Docker to continue.");
        process.exit(1);
      }
      console.log("Starting Docker services...");
      const result = startServices(repo.name, integrationConfig, secrets);
      if (result.started) {
        console.log(`  Services ready: ${result.services.join(", ")}\n`);
      } else {
        console.error(`  Failed: ${result.error}`);
        process.exit(1);
      }
    }

    // Scaffold test utilities
    console.log("Scaffolding test utilities...");
    const scaffold = scaffoldIntegrationTests(repo, integrationConfig);
    for (const f of scaffold.filesCreated) console.log(`  Created: ${f}`);
    for (const f of scaffold.filesSkipped) console.log(`  Skipped (exists): ${f}`);

    console.log(`\nSetup complete. Run 'ym integration test --repo ${repo.name}' to test.`);
  });

integrationCmd
  .command("start")
  .description("Start the Docker services (postgres, redis, keycloak, etc.) defined in the repo's integration config without running any tests.")
  .requiredOption("--repo <name>", "Repository name")
  .action(async (opts: { repo: string }) => {
    const { loadIntegrationConfig } = await import("./integration/config.js");
    const { startServices } = await import("./integration/docker.js");
    const integrationConfig = loadIntegrationConfig(opts.repo);
    if (!integrationConfig) {
      console.error(`No integration config for ${opts.repo}`);
      process.exit(1);
    }
    const result = startServices(opts.repo, integrationConfig);
    if (result.started) {
      console.log(`Services started: ${result.services.join(", ")}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  });

integrationCmd
  .command("stop")
  .description("Stop all Docker services that were started for the repo's integration tests.")
  .requiredOption("--repo <name>", "Repository name")
  .action(async (opts: { repo: string }) => {
    const { stopServices } = await import("./integration/docker.js");
    stopServices(opts.repo);
    console.log("Services stopped");
  });

integrationCmd
  .command("test")
  .description("Run the repo's integration tests manually (outside the normal pipeline), with up to 2 auto-fix attempts on failure.")
  .requiredOption("--repo <name>", "Repository name")
  .action(async (opts: { repo: string }) => {
    const config = loadConfig();
    const repo = getRepo(config, opts.repo);
    const { runIntegrationTests } = await import("./integration/runner.js");

    const result = await runIntegrationTests(config, repo, "manual", repo.localPath, "manual integration test run");
    if (!result.ran) {
      console.log(`Skipped: ${result.output}`);
    } else if (result.passed) {
      console.log(`Passed${result.attempts > 0 ? ` after ${result.attempts} attempts` : ""}`);
    } else {
      console.error(`Failed after ${result.attempts} attempts`);
      console.error(result.output.slice(0, 500));
      process.exit(1);
    }
  });

// ── ym capacity ─────────────────────────────────────────
program
  .command("capacity")
  .description("Check current Claude rate-limit capacity and whether new tasks can be started, including overage status and reset time.")
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
    case "completed":    return "[done]";
    case "running":      return "[....]";
    case "failed":       return "[FAIL]";
    case "partial":      return "[part]";
    case "pending":      return "[wait]";
    case "interrupted":  return "[intr]";
    default:             return `[${status}]`;
  }
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const helperCmd = program
  .command("helper")
  .description("Utility sub-commands for authentication and external service workflows.");

helperCmd
  .command("oidc-auth")
  .description("Obtain a JWT access token from a Keycloak-compatible OIDC provider via the resource owner password grant. Prints the access token by default; use --json for the full response.")
  .requiredOption("--issuer <url>", "OIDC issuer URL (e.g. https://auth.example.com/realms/myrealm)")
  .requiredOption("--client-id <id>", "OAuth2 client ID registered with the OIDC provider")
  .option("--client-secret <secret>", "OAuth2 client secret; alternatively set the OIDC_CLIENT_SECRET environment variable")
  .requiredOption("--username <user>", "Username to authenticate (resource owner password grant)")
  .option("--password <pass>", "Password to authenticate; alternatively set the OIDC_PASSWORD environment variable")
  .option("--json", "Output the full token response as JSON instead of just the access token")
  .action(async (opts: { issuer: string; clientId: string; clientSecret?: string; username: string; password?: string; json?: boolean }) => {
    try {
      const password = opts.password || process.env.OIDC_PASSWORD || "";
      if (!password) {
        throw new Error("--password or OIDC_PASSWORD required");
      }
      const { getOidcToken } = await import("./helpers/oidc-auth.js");
      const result = await getOidcToken({
        issuerUrl: opts.issuer,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret || process.env.OIDC_CLIENT_SECRET,
        username: opts.username,
        password,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.accessToken);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ── ym new ──────────────────────────────────────────────
program
  .command("new")
  .description("Scaffold a new project and register it in Yardmaster.")
  .option("--file <path>", "Project spec file (markdown or JSON). If omitted, a discovery agent infers a spec from defaults.")
  .option("--org <org>", "GitHub org/user (overrides spec; defaults to authenticated GitHub user)")
  .action(async (opts: { file?: string; org?: string }) => {
    console.log("\nYardmaster — New Project\n");
    const config = loadConfig();

    const { runDiscovery, extractSpecFromFile } = await import("./new-project/discovery.js");
    const { runScaffold } = await import("./new-project/scaffold.js");

    let spec = opts.file
      ? await extractSpecFromFile(config, opts.file)
      : await runDiscovery(config);

    if (opts.org) {
      spec.githubOrg = opts.org;
    }

    if (!spec.githubOrg) {
      try {
        const { execSync } = await import("node:child_process");
        spec.githubOrg = execSync("gh api user -q .login", { encoding: "utf-8" }).trim();
        console.log(`  (no --org specified, using GitHub user: ${spec.githubOrg})`);
      } catch {
        console.error("Error: githubOrg is required (set in spec, pass --org, or ensure `gh` is authenticated).");
        process.exit(1);
      }
    }

    // Convention: ~/code/gibson-ops/<project>. When no companyDir is specified
    // in the spec, default to gibson-ops (hyphenated).
    if (!spec.companyDir) {
      spec.companyDir = "gibson-ops";
    }

    const dirName = spec.companyDir;

    console.log(`\nProject: ${spec.displayName || spec.name}`);
    console.log(`Platform: ${spec.platform} (${spec.framework ?? "none"})`);
    console.log(`Backend: ${spec.backend || "none"}`);
    console.log(`Path: ~/code/${dirName}/${spec.name}\n`);

    const result = await runScaffold(config, spec);

    console.log(`\n✓ Project created at ${result.projectPath}`);
    console.log(`✓ GitHub: ${result.githubUrl}`);
    console.log(`✓ Registered in repos.json as "${spec.name}"`);
    console.log(`\nReady for: ym task "your first feature" --repo ${spec.name}`);
  });

// ── ym telegram ─────────────────────────────────────────
program
  .command("telegram")
  .description("Start the Telegram bot for querying task status, queue, and capacity via chat. Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.")
  .action(async () => {
    const { startBot } = await import("./telegram/bot.js");
    await startBot();
  });

program.parse();
