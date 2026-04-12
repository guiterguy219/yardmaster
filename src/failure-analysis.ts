import { execSync } from "node:child_process";
import { getDb } from "./db.js";
import { loadConfig } from "./config.js";
import { runAgent } from "./agent-runner.js";
import { ghExecEnv } from "./gh-auth.js";

interface FailurePattern {
  category: string;
  count: number;
  lastSeen: string;
  examples: string[];
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS failure_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Analyze a failed task and classify the failure pattern.
 * Uses haiku for cheap classification.
 */
export async function analyzeFailure(
  taskId: string,
  taskDescription: string,
  error: string,
  reviewSummary: string
): Promise<string> {
  ensureTable();
  const config = loadConfig();

  let category: string;
  try {
    const result = await runAgent(config, {
      prompt: `Classify this task failure into exactly one category.

Task: ${taskDescription.slice(0, 300)}
Error: ${error.slice(0, 300)}
Review summary: ${reviewSummary.slice(0, 500)}

Categories:
- oscillation: reviewers kept disagreeing, code went in circles
- complexity: task was too large or touched too many files
- type-error: code didn't compile or had type issues
- tooling: infrastructure problem (git, gh, redis, claude CLI)
- coder-limitation: coder produced incorrect or incomplete code
- reviewer-conflict: style and logic reviewers gave contradictory feedback

Return ONLY the category name, nothing else.`,
      systemPrompt: "You classify task failures. Return ONLY the category name.",
      workingDir: process.cwd(),
      allowedTools: [],
      model: "haiku",
      timeout: 30_000,
    });

    category = result.result.trim().toLowerCase();
    // Normalize to known categories
    const known = ["oscillation", "complexity", "type-error", "tooling", "coder-limitation", "reviewer-conflict"];
    if (!known.includes(category)) category = "unknown";
  } catch {
    category = "unknown";
  }

  // Record the pattern
  getDb()
    .prepare("INSERT INTO failure_patterns (task_id, category, description) VALUES (?, ?, ?)")
    .run(taskId, category, `${error.slice(0, 200)} | ${reviewSummary.slice(0, 200)}`);

  // Check if this pattern has occurred 3+ times
  const pattern = getDb()
    .prepare(
      `SELECT category, COUNT(*) as count, MAX(created_at) as last_seen
       FROM failure_patterns
       WHERE category = ? AND created_at > datetime('now', '-7 days')
       GROUP BY category`
    )
    .get(category) as { category: string; count: number; last_seen: string } | undefined;

  if (pattern && pattern.count >= 3) {
    await createSelfImprovementIssue(pattern.category, pattern.count);
  }

  return category;
}

/**
 * Create a GitHub issue on the yardmaster repo for a recurring failure pattern.
 */
async function createSelfImprovementIssue(category: string, count: number): Promise<void> {
  const config = loadConfig();
  const ymRepo = config.repos.find((r) => r.name === "yardmaster");
  if (!ymRepo) return;

  // Check if we already have an open issue for this category
  try {
    const existing = execSync(
      `gh issue list --repo "${ymRepo.githubOrg}/${ymRepo.githubRepo}" --label "ym-self-improvement" --search "${category}" --state open --json number --limit 1`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: ghExecEnv(ymRepo.githubOrg) }
    );
    const issues = JSON.parse(existing) as Array<{ number: number }>;
    if (issues.length > 0) return; // Already have an open issue
  } catch {
    return; // Can't check, skip
  }

  const descriptions: Record<string, string> = {
    oscillation: "The review loop is oscillating — reviewers raise issues the coder fixes, then re-raise them in different words. Improve cumulative context or tighten the oscillation detection threshold.",
    complexity: "Tasks are too complex for the planner to decompose effectively. Improve the planner's decomposition strategy or add guidance on maximum sub-task scope.",
    "type-error": "Coder is producing code that doesn't compile. Consider adding a type-check step within the review loop (not just before PR), so the coder gets compile errors as feedback.",
    tooling: "Infrastructure failures (git, gh, redis, claude CLI) are causing task failures. Run ym doctor and fix the underlying tooling issues.",
    "coder-limitation": "The coder agent is producing incorrect or incomplete code. Consider improving the coder prompt, adding more context from CLAUDE.md, or providing better examples.",
    "reviewer-conflict": "Style and logic reviewers are giving contradictory feedback. Consider merging them into a single reviewer or adding explicit rules about which reviewer's opinion takes precedence.",
  };

  const body = `## Recurring failure pattern: ${category}

This pattern has occurred ${count} times in the last 7 days.

### Problem
${descriptions[category] ?? `Unknown failure category: ${category}`}

### Suggested investigation
1. Check recent task logs: \`SELECT * FROM task_logs WHERE task_id IN (SELECT task_id FROM failure_patterns WHERE category = '${category}' ORDER BY created_at DESC LIMIT 5)\`
2. Review the diff ledger for these tasks
3. Identify the root cause and implement a fix

---
*Auto-created by Yardmaster failure analysis*`;

  try {
    execSync(
      `gh issue create --repo "${ymRepo.githubOrg}/${ymRepo.githubRepo}" --title "Self-improvement: recurring ${category} failures" --body ${shellEscape(body)} --label "ym-self-improvement,ym"`,
      { stdio: "pipe", env: ghExecEnv(ymRepo.githubOrg) }
    );
    console.log(`  [Self-improvement] Created issue for recurring ${category} failures`);
  } catch {
    // Best effort — don't block the pipeline
  }
}

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Get failure pattern statistics.
 */
export function getFailureStats(): FailurePattern[] {
  ensureTable();
  const rows = getDb()
    .prepare(
      `SELECT category, COUNT(*) as count, MAX(created_at) as last_seen,
              GROUP_CONCAT(description, '|||') as examples
       FROM failure_patterns
       WHERE created_at > datetime('now', '-30 days')
       GROUP BY category
       ORDER BY count DESC`
    )
    .all() as Array<{ category: string; count: number; last_seen: string; examples: string }>;

  return rows.map((r) => ({
    category: r.category,
    count: r.count,
    lastSeen: r.last_seen,
    examples: r.examples.split("|||").slice(0, 3),
  }));
}
