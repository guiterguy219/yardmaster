import { execSync } from "node:child_process";
import { loadConfig, type YardmasterConfig } from "./config.js";
import { getDb } from "./db.js";
import { runAgent } from "./agent-runner.js";
import { enqueueTask } from "./queue/task-queue.js";
import { PRIORITY, type PriorityLevel } from "./queue/constants.js";
import { notifyQueued } from "./issue-lifecycle.js";
import { ghExecEnv } from "./gh-auth.js";

export interface ScanResult {
  queued: number;
  skipped: number;
  errors: string[];
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS queued_issues (
      issue_ref TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      queued_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS skipped_issues (
      issue_ref TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      skipped_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function isAlreadyQueued(issueRef: string): boolean {
  ensureTable();
  const row = getDb()
    .prepare("SELECT 1 FROM queued_issues WHERE issue_ref = ?")
    .get(issueRef);
  return !!row;
}

/** Skipped entries older than this many days are re-evaluated on next scan. */
const SKIP_TTL_DAYS = 14;

function isAlreadySkipped(issueRef: string): boolean {
  ensureTable();
  const row = getDb()
    .prepare(
      "SELECT 1 FROM skipped_issues WHERE issue_ref = ? AND skipped_at > datetime('now', ?)"
    )
    .get(issueRef, `-${SKIP_TTL_DAYS} days`);
  return !!row;
}

function recordSkippedIssue(issueRef: string, reason: string): void {
  ensureTable();
  getDb()
    .prepare("INSERT OR REPLACE INTO skipped_issues (issue_ref, reason) VALUES (?, ?)")
    .run(issueRef, reason);
}

function recordQueuedIssue(issueRef: string, jobId: string): void {
  ensureTable();
  getDb()
    .prepare("INSERT OR IGNORE INTO queued_issues (issue_ref, job_id) VALUES (?, ?)")
    .run(issueRef, jobId);
}

function priorityFromLabels(labels: Array<{ name: string }>): PriorityLevel | null {
  const names = labels.map((l) => l.name.toLowerCase());
  if (names.includes("ym-urgent")) return PRIORITY.URGENT;
  if (names.includes("ym-high")) return PRIORITY.HIGH;
  if (names.includes("ym-low")) return PRIORITY.LOW;
  return null; // needs auto-classification
}

async function classifyIssue(
  config: YardmasterConfig,
  title: string,
  body: string
): Promise<PriorityLevel> {
  try {
    const result = await runAgent(config, {
      prompt: `Classify this GitHub issue as exactly one word: bug, feature, or tech-debt.\n\nTitle: ${title}\n\nBody: ${(body ?? "").slice(0, 500)}`,
      systemPrompt: "You classify GitHub issues. Return ONLY one word: bug, feature, or tech-debt. Nothing else.",
      workingDir: process.cwd(),
      allowedTools: [],
      model: "haiku",
      timeout: 30_000,
    });

    const word = result.result.trim().toLowerCase();
    if (word.includes("bug")) return PRIORITY.HIGH;
    if (word.includes("tech")) return PRIORITY.LOW;
    return PRIORITY.NORMAL; // feature or unrecognized
  } catch {
    return PRIORITY.NORMAL;
  }
}

async function classifyActionability(
  config: YardmasterConfig,
  title: string,
  body: string,
  labels: Array<{ name: string }>
): Promise<{ actionable: boolean; reason: string }> {
  try {
    const labelNames = labels.map((l) => l.name).join(", ");
    const truncatedBody = (body ?? "").slice(0, 500);
    const result = await runAgent(config, {
      prompt: `Classify this GitHub issue as either an actionable coding task or a non-actionable item (tracker, meta, discussion, question, or informational).\n\n<issue-title>${title}</issue-title>\n<issue-labels>${labelNames}</issue-labels>\n<issue-body>${truncatedBody}</issue-body>\n\nReturn exactly one word: actionable or non-actionable.`,
      systemPrompt:
        "You classify GitHub issues. Return ONLY one word: actionable or non-actionable. An actionable issue is a concrete coding task (bug fix, feature, refactor). A non-actionable issue is a tracker, meta issue, discussion, question, or informational note with no clear coding work.",
      workingDir: process.cwd(),
      allowedTools: [],
      model: "haiku",
      timeout: 30_000,
    });

    const classification = result.result.trim().toLowerCase();
    if (classification === "non-actionable") {
      return { actionable: false, reason: "classified as non-actionable" };
    }
    return { actionable: true, reason: "" };
  } catch {
    // Fail open — treat as actionable on error
    return { actionable: true, reason: "" };
  }
}

export async function scanReposForIssues(config?: YardmasterConfig): Promise<ScanResult> {
  const cfg = config ?? loadConfig();
  const result: ScanResult = { queued: 0, skipped: 0, errors: [] };

  for (const repo of cfg.repos) {
    const fullRepo = `${repo.githubOrg}/${repo.githubRepo}`;

    let issues: GitHubIssue[];
    try {
      // Note: ym-skip is intentionally not in the search query — issues with only
      // ym-skip (and no other ym-* label) won't be fetched. The ym-skip fast-path
      // below handles issues that have ym-skip alongside another ym-* label.
      const raw = execSync(
        `gh issue list --repo "${fullRepo}" --search "label:ym,ym-urgent,ym-high,ym-low" --state open --json number,title,body,labels --limit 50`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: ghExecEnv(repo.githubOrg) }
      );
      issues = JSON.parse(raw) as GitHubIssue[];
    } catch (err) {
      result.errors.push(`${fullRepo}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const issue of issues) {
      const issueRef = `${fullRepo}#${issue.number}`;

      if (isAlreadyQueued(issueRef)) {
        result.skipped++;
        continue;
      }

      if (isAlreadySkipped(issueRef)) {
        result.skipped++;
        continue;
      }

      // Fast-path: ym-skip label
      if (issue.labels.some((l) => l.name.toLowerCase() === "ym-skip")) {
        recordSkippedIssue(issueRef, "ym-skip label");
        console.log(`  Skipped: ${issueRef} (ym-skip label)`);
        result.skipped++;
        continue;
      }

      // Actionability check
      const issueBody = issue.body ?? "";
      const actionability = await classifyActionability(cfg, issue.title, issueBody, issue.labels);
      if (!actionability.actionable) {
        recordSkippedIssue(issueRef, actionability.reason);
        console.log(`  Skipped: ${issueRef} (${actionability.reason})`);
        result.skipped++;
        continue;
      }

      // Determine priority
      let priority = priorityFromLabels(issue.labels);
      if (priority === null) {
        priority = await classifyIssue(cfg, issue.title, issueBody);
      }

      // Build task description
      const taskDescription = `${issue.title}\n\n${issueBody}\n\nCloses ${issueRef}`;

      try {
        const jobId = await enqueueTask(
          repo.name,
          taskDescription,
          priority,
          "github-issue",
          issueRef
        );
        recordQueuedIssue(issueRef, jobId);
        notifyQueued(issueRef, jobId);
        result.queued++;
        console.log(`  Queued: ${issueRef} → ${repo.name} [P${priority}]`);
      } catch (err) {
        result.errors.push(`${issueRef}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}
