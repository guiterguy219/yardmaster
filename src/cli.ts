import { readFileSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { Command } from "commander";
import { executeTask } from "./task-runner.js";
import { loadConfig, getRepo } from "./config.js";
import { getRecentTasks } from "./db.js";
import { checkCapacity } from "./capacity.js";
import { enqueueTask, getQueueContents, removeJob, changePriority, closeQueue } from "./queue/task-queue.js";
import { startWorker, stopWorker } from "./queue/task-worker.js";
import { PRIORITY, PRIORITY_LABELS, parsePriority, type PriorityLevel } from "./queue/constants.js";
import { scanReposForIssues } from "./issue-scanner.js";
import { runDoctor } from "./doctor.js";
import { onboardRepo } from "./onboarding.js";
import { detectAndMarkInterrupted, recoverInterruptedTasks } from "./recovery.js";
import { removeOrphanedWorktrees } from "./worktree.js";
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
  .description("Run an autonomous coding task immediately (P0)")
  .argument("[description]", "What the agent should do")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--file <path>", "Read task description from a file")
  .action(async (description: string | undefined, opts: { repo: string; file?: string }) => {
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

// ── ym worker-status ────────────────────────────────────
program
  .command("worker-status")
  .description("Show systemd service, Redis, queue depth, and last task")
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
  .command("recover")
  .description("Detect dead workers, recover interrupted tasks, and GC orphaned worktrees")
  .option("--gc", "Also remove orphaned worktrees for completed/failed tasks")
  .action(async (opts: { gc?: boolean }) => {
    const config = loadConfig();

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
  .description("Ingest CLAUDE.md and config files into the context store")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .action(async (opts: { repo: string }) => {
    await runIngest(opts.repo);
  });

// ── ym context ─────────────────────────────────────────
const contextCmd = program
  .command("context")
  .description("Manage the context store (search, lookup, ingest, stats)");

contextCmd
  .command("search")
  .description("Search context entries by keyword")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .argument("<query>", "Search term to match against key and content")
  .option("--kind <kind>", "Filter by kind: file, dependency, convention, snippet, note")
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
  .description("Look up a specific context entry by id or by repo/kind/key")
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
  .description("Ingest CLAUDE.md and config files into the context store")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .action(async (opts: { repo: string }) => {
    await runIngest(opts.repo);
  });

contextCmd
  .command("ingest-docs")
  .description("Fetch, chunk, and store web documentation pages")
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
  .description("Remove stale documentation entries older than N days")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--days <n>", "Remove entries older than this many days", "30")
  .action((opts: { repo: string; days: string }) => {
    const days = parseDays(opts.days);

    const removed = pruneStaleDocEntries(opts.repo, days);
    console.log(`\nPruned ${removed} stale doc entries (older than ${days} days) for ${opts.repo}.\n`);
  });

contextCmd
  .command("docs")
  .description("Search the web for documentation, then fetch, chunk, and store it")
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
  .description("Purge stale web doc entries and their raw content hashes")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--days <n>", "Remove entries older than this many days", "30")
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
  .description("Show context budget usage per agent role")
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
  .description("Analyze completed task history and extract insights")
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
  .description("Run all context maintenance tasks (purge stale docs + ingest history)")
  .option("--repo <name>", "Target repository name (or all repos if omitted)")
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

program.parse();
