import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const dbPath = join(config.dataDir, "yardmaster.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT,
      pr_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS capacity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resets_at INTEGER,
      rate_limit_type TEXT,
      is_using_overage INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      prompt_summary TEXT,
      result_summary TEXT,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has("pipeline_stage")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pipeline_stage TEXT");
  }
  if (!colNames.has("worker_pid")) {
    db.exec("ALTER TABLE tasks ADD COLUMN worker_pid INTEGER");
  }
}

export function createTask(repo: string, description: string): string {
  const db = getDb();
  const id = `ym-${Date.now().toString(36)}`;
  db.prepare(
    "INSERT INTO tasks (id, repo, description, status) VALUES (?, ?, ?, 'pending')"
  ).run(id, repo, description);
  return id;
}

export function updateTask(
  id: string,
  fields: Partial<{ status: TaskStatus; branch: string; pr_url: string; error: string }>
): void {
  const db = getDb();
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }

  values.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

// 'completed' is the canonical success status; 'done' is retained for backward-compat
// with pre-migration rows. Callers must treat both as equivalent success states.
export type TaskStatus = 'pending' | 'running' | 'completed' | 'partial' | 'done' | 'failed' | 'interrupted';

export type TaskRow = {
  id: string;
  repo: string;
  description: string;
  status: TaskStatus;
  branch: string | null;
  pr_url: string | null;
  error: string | null;
  pipeline_stage: string | null;
  worker_pid: number | null;
  created_at: string;
  updated_at: string;
};

export function getTask(id: string): TaskRow | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
}

export function getRecentTasks(limit = 10): TaskRow[] {
  return getDb()
    .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
    .all(limit) as TaskRow[];
}

export function updatePipelineStage(id: string, stage: string, workerPid?: number): void {
  const db = getDb();
  const sets: string[] = ["updated_at = datetime('now')", "pipeline_stage = ?"];
  const values: unknown[] = [stage];

  if (workerPid !== undefined) {
    sets.push("worker_pid = ?");
    values.push(workerPid);
  }

  values.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/**
 * Atomically transition a task from interrupted → running.
 * Returns true if the claim succeeded (this worker owns the task),
 * false if another worker already claimed it.
 */
export function claimInterruptedTask(id: string): boolean {
  const result = getDb()
    .prepare(
      "UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'interrupted'"
    )
    .run(id);
  return result.changes > 0;
}

export function getInterruptedTasks(): TaskRow[] {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE status = 'interrupted' ORDER BY created_at DESC")
    .all() as TaskRow[];
}

export function getRunningTasks(): TaskRow[] {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY created_at DESC")
    .all() as TaskRow[];
}

export function logAgentRun(
  taskId: string,
  agent: string,
  round: number,
  promptSummary: string,
  resultSummary: string,
  durationMs: number,
  success: boolean
): void {
  getDb()
    .prepare(
      `INSERT INTO task_logs (task_id, agent, round, prompt_summary, result_summary, duration_ms, success)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(taskId, agent, round, promptSummary, resultSummary, durationMs, success ? 1 : 0);
}
