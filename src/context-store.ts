import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextKind = "file" | "dependency" | "convention" | "snippet" | "note";

export interface ContextEntry {
  id: number;
  repo: string;
  kind: ContextKind;
  key: string;
  content: string;
  contentHash: string;
  agentRoles: string[];
  createdAt: string;
  updatedAt: string;
}

interface ContextRow {
  id: number;
  repo: string;
  kind: string;
  key: string;
  content: string;
  content_hash: string;
  agent_roles: string;
  created_at: string;
  updated_at: string;
}

function rowToEntry(row: ContextRow): ContextEntry {
  return {
    id: row.id,
    repo: row.repo,
    kind: row.kind as ContextKind,
    key: row.key,
    content: row.content,
    contentHash: row.content_hash,
    agentRoles: JSON.parse(row.agent_roles) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function upsertContext(
  repo: string,
  kind: ContextKind,
  key: string,
  content: string,
  agentRoles: string[] = [],
): ContextEntry {
  const db = getDb();
  const contentHash = hashContent(content);
  const rolesJson = JSON.stringify(agentRoles);

  db.prepare(`
    INSERT INTO context_entries (repo, kind, key, content, content_hash, agent_roles)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, kind, key) DO UPDATE SET
      content = excluded.content,
      content_hash = excluded.content_hash,
      agent_roles = excluded.agent_roles,
      updated_at = datetime('now')
  `).run(repo, kind, key, content, contentHash, rolesJson);

  return getContext(repo, kind, key)!;
}

export function getContext(
  repo: string,
  kind: ContextKind,
  key: string,
): ContextEntry | undefined {
  const row = getDb()
    .prepare("SELECT * FROM context_entries WHERE repo = ? AND kind = ? AND key = ?")
    .get(repo, kind, key) as ContextRow | undefined;

  return row ? rowToEntry(row) : undefined;
}

export function getContextById(id: number): ContextEntry | undefined {
  const row = getDb()
    .prepare("SELECT * FROM context_entries WHERE id = ?")
    .get(id) as ContextRow | undefined;

  return row ? rowToEntry(row) : undefined;
}

export function listContext(
  repo: string,
  kind?: ContextKind,
): ContextEntry[] {
  const db = getDb();

  if (kind) {
    const rows = db
      .prepare("SELECT * FROM context_entries WHERE repo = ? AND kind = ? ORDER BY updated_at DESC")
      .all(repo, kind) as ContextRow[];
    return rows.map(rowToEntry);
  }

  const rows = db
    .prepare("SELECT * FROM context_entries WHERE repo = ? ORDER BY updated_at DESC")
    .all(repo) as ContextRow[];
  return rows.map(rowToEntry);
}

export function listContextForRole(
  repo: string,
  role: string,
): ContextEntry[] {
  // agent_roles is stored as a JSON array; use LIKE for lightweight filtering
  const rows = getDb()
    .prepare(
      `SELECT * FROM context_entries
       WHERE repo = ? AND agent_roles LIKE ?
       ORDER BY updated_at DESC`
    )
    .all(repo, `%"${role}"%`) as ContextRow[];

  return rows.map(rowToEntry);
}

export function deleteContext(
  repo: string,
  kind: ContextKind,
  key: string,
): boolean {
  const result = getDb()
    .prepare("DELETE FROM context_entries WHERE repo = ? AND kind = ? AND key = ?")
    .run(repo, kind, key);

  return result.changes > 0;
}

export function deleteContextById(id: number): boolean {
  const result = getDb()
    .prepare("DELETE FROM context_entries WHERE id = ?")
    .run(id);

  return result.changes > 0;
}

export function clearRepoContext(repo: string): number {
  const result = getDb()
    .prepare("DELETE FROM context_entries WHERE repo = ?")
    .run(repo);

  return result.changes;
}

/**
 * Search context entries by keyword against key and content fields.
 * Returns entries where the query appears in the key or content (case-insensitive).
 */
export function searchContext(
  repo: string,
  query: string,
  kind?: ContextKind,
): ContextEntry[] {
  const db = getDb();
  const pattern = `%${query}%`;

  if (kind) {
    const rows = db
      .prepare(
        `SELECT * FROM context_entries
         WHERE repo = ? AND kind = ? AND (key LIKE ? OR content LIKE ?)
         ORDER BY updated_at DESC`
      )
      .all(repo, kind, pattern, pattern) as ContextRow[];
    return rows.map(rowToEntry);
  }

  const rows = db
    .prepare(
      `SELECT * FROM context_entries
       WHERE repo = ? AND (key LIKE ? OR content LIKE ?)
       ORDER BY updated_at DESC`
    )
    .all(repo, pattern, pattern) as ContextRow[];
  return rows.map(rowToEntry);
}

// ---------------------------------------------------------------------------
// Cache freshness
// ---------------------------------------------------------------------------

/**
 * Returns true if the repo has context entries updated within the given
 * number of minutes. Useful for skipping re-ingestion when context is fresh.
 */
export function hasRecentEntries(repo: string, withinMinutes: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM context_entries
       WHERE repo = ? AND updated_at > datetime('now', ?)
       LIMIT 1`
    )
    .get(repo, `-${withinMinutes} minutes`) as { 1: number } | undefined;

  return row !== undefined;
}

// ---------------------------------------------------------------------------
// File ingestion helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the file content has changed since last ingestion
 * (or has never been ingested).
 */
export function hasFileChanged(repo: string, key: string, content: string): boolean {
  const existing = getContext(repo, "file", key);
  if (!existing) return true;
  return existing.contentHash !== hashContent(content);
}

/**
 * Ingest local files from a repo — reads each path, computes hash,
 * skips unchanged files. Returns count of entries upserted.
 */
export function ingestLocalFiles(
  repo: string,
  basePath: string,
  relativePaths: string[],
  agentRoles: string[] = [],
): number {
  const db = getDb();
  let upserted = 0;

  const ingestTx = db.transaction(() => {
    for (const relPath of relativePaths) {
      const fullPath = `${basePath}/${relPath}`;
      if (!existsSync(fullPath)) continue;

      const content = readFileSync(fullPath, "utf-8");
      if (!hasFileChanged(repo, relPath, content)) continue;

      upsertContext(repo, "file", relPath, content, agentRoles);
      upserted++;
    }
  });

  ingestTx();
  return upserted;
}

/**
 * Extract dependencies from a package.json and store each as a
 * "dependency" context entry.
 */
export function ingestPackageJson(
  repo: string,
  packageJsonPath: string,
  agentRoles: string[] = [],
): number {
  if (!existsSync(packageJsonPath)) return 0;

  const raw = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const db = getDb();
  let upserted = 0;

  const ingestTx = db.transaction(() => {
    const deps = raw.dependencies ?? {};
    for (const [name, version] of Object.entries(deps)) {
      const content = JSON.stringify({ name, version, dev: false });
      if (!hasFileChanged(repo, `dep:${name}`, content)) continue;
      upsertContext(repo, "dependency", `dep:${name}`, content, agentRoles);
      upserted++;
    }

    const devDeps = raw.devDependencies ?? {};
    for (const [name, version] of Object.entries(devDeps)) {
      const content = JSON.stringify({ name, version, dev: true });
      if (!hasFileChanged(repo, `dep:${name}`, content)) continue;
      upsertContext(repo, "dependency", `dep:${name}`, content, agentRoles);
      upserted++;
    }
  });

  ingestTx();
  return upserted;
}
