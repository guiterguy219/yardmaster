import { getDb } from "../db.js";
import { getReviewSummaries } from "../diff-ledger.js";
import { upsertContext, getContext } from "../context-store.js";
import { runAgent } from "../agent-runner.js";
import { parseAgentJson } from "../utils/parse-json.js";
import type { YardmasterConfig } from "../config.js";
import {
  HISTORY_INGESTOR_SYSTEM_PROMPT,
  buildHistoryIngestorPrompt,
  type HistoryIngestorOutput,
} from "../prompts/history-ingestor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskSummaryRow {
  id: string;
  description: string;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Analyze completed task history for a repo and store insights.
 * Only re-analyzes if new tasks have been completed since the last analysis.
 */
export async function ingestTaskHistory(
  config: YardmasterConfig,
  repoName: string,
): Promise<{ insights: number; tasksAnalyzed: number }> {
  const db = getDb();

  // Count completed tasks for this repo
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM tasks
       WHERE repo = ? AND status IN ('completed', 'done')
         AND created_at > datetime('now', '-30 days')`,
    )
    .get(repoName) as { count: number };

  const currentCount = row.count;

  if (currentCount === 0) {
    return { insights: 0, tasksAnalyzed: 0 };
  }

  // Check if we already analyzed this many tasks
  const lastAnalyzed = getContext(repoName, "note", "history:last-analyzed");
  if (lastAnalyzed && lastAnalyzed.content === String(currentCount)) {
    return { insights: 0, tasksAnalyzed: 0 };
  }

  // Fetch the 20 most recent completed tasks
  const tasks = db
    .prepare(
      `SELECT id, description, status, created_at FROM tasks
       WHERE repo = ? AND status IN ('completed', 'done')
         AND created_at > datetime('now', '-30 days')
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(repoName) as TaskSummaryRow[];

  // Build summary text
  const summaryParts: string[] = [];
  for (const task of tasks) {
    const reviews = getReviewSummaries(task.id);
    const roundCount = reviews.length > 0
      ? Math.max(...reviews.map((r) => r.round))
      : 0;

    const issues: string[] = [];
    for (const review of reviews) {
      try {
        const parsed = JSON.parse(review.issues_json) as Array<{ description?: string }>;
        for (const issue of parsed) {
          if (issue.description) {
            issues.push(issue.description.slice(0, 50));
          }
        }
      } catch {
        // skip malformed issues
      }
    }

    const finalVerdict = reviews.length > 0
      ? reviews[reviews.length - 1].verdict
      : "unknown";

    summaryParts.push(
      `Task: ${task.description.slice(0, 100)}\n` +
      `  Rounds: ${roundCount}\n` +
      `  Review issues: ${issues.join(", ") || "none"}\n` +
      `  Final verdict: ${finalVerdict}`,
    );
  }

  const summary = summaryParts.join("\n\n");

  // Call haiku to extract insights
  const result = await runAgent(config, {
    prompt: buildHistoryIngestorPrompt(summary),
    systemPrompt: HISTORY_INGESTOR_SYSTEM_PROMPT,
    workingDir: config.dataDir,
    allowedTools: [],
    model: "haiku",
    timeout: 60_000,
  });

  if (!result.success) {
    return { insights: 0, tasksAnalyzed: tasks.length };
  }

  const parsed = parseAgentJson<HistoryIngestorOutput>(result.result);
  if (!parsed?.insights || !Array.isArray(parsed.insights)) {
    return { insights: 0, tasksAnalyzed: tasks.length };
  }

  // Store each insight
  let stored = 0;
  for (const insight of parsed.insights) {
    if (!insight.key || !insight.content) continue;
    // Ensure key starts with "history:"
    const key = insight.key.startsWith("history:") ? insight.key : `history:${insight.key}`;
    const roles = Array.isArray(insight.agentRoles) ? insight.agentRoles : [];
    upsertContext(repoName, "note", key, insight.content, roles);
    stored++;
  }

  // Record the analysis watermark
  upsertContext(repoName, "note", "history:last-analyzed", String(currentCount));

  return { insights: stored, tasksAnalyzed: tasks.length };
}
