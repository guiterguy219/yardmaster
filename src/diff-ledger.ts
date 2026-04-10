import { getDb } from "./db.js";

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS review_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      round INTEGER NOT NULL,
      agent TEXT NOT NULL,
      verdict TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      diff_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export function logReviewRound(
  taskId: string,
  round: number,
  agent: string,
  verdict: string,
  issues: unknown[],
  diff: string
): void {
  ensureTable();
  getDb()
    .prepare(
      `INSERT INTO review_rounds (task_id, round, agent, verdict, issues_json, diff_text)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(taskId, round, agent, verdict, JSON.stringify(issues), diff);
}

export function getReviewHistory(taskId: string): Array<{
  id: number;
  task_id: string;
  round: number;
  agent: string;
  verdict: string;
  issues_json: string;
  diff_text: string;
  created_at: string;
}> {
  ensureTable();
  return getDb()
    .prepare("SELECT * FROM review_rounds WHERE task_id = ? ORDER BY round, agent")
    .all(taskId) as Array<{
    id: number;
    task_id: string;
    round: number;
    agent: string;
    verdict: string;
    issues_json: string;
    diff_text: string;
    created_at: string;
  }>;
}

/**
 * Lightweight query that excludes diff_text to avoid loading large diffs into memory.
 * Use this when you only need round metadata and issues (e.g., building prior rounds context).
 */
export function getReviewSummaries(taskId: string): Array<{
  round: number;
  agent: string;
  verdict: string;
  issues_json: string;
}> {
  ensureTable();
  return getDb()
    .prepare("SELECT round, agent, verdict, issues_json FROM review_rounds WHERE task_id = ? ORDER BY round, agent")
    .all(taskId) as Array<{
    round: number;
    agent: string;
    verdict: string;
    issues_json: string;
  }>;
}
