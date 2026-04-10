import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaintenanceStats {
  totalEntries: number;
  docEntries: number;
  staleDocEntries: number;
  oldestDocUpdate: string | null;
  newestDocUpdate: string | null;
  byKind: Record<string, number>;
  totalContentBytes: number;
}

interface CountRow {
  count: number;
}

interface AggRow {
  oldest: string | null;
  newest: string | null;
}

interface KindCountRow {
  kind: string;
  count: number;
}

interface BytesRow {
  total_bytes: number;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Gather maintenance-relevant statistics for a repo's context store.
 * Reports total entries, doc entry counts, staleness info, and size.
 */
export function getMaintenanceStats(
  repo: string,
  staleDays: number = 30,
): MaintenanceStats {
  const db = getDb();

  const total = db
    .prepare("SELECT COUNT(*) as count FROM context_entries WHERE repo = ?")
    .get(repo) as CountRow;

  const docs = db
    .prepare(
      "SELECT COUNT(*) as count FROM context_entries WHERE repo = ? AND key LIKE 'docs:%'",
    )
    .get(repo) as CountRow;

  const stale = db
    .prepare(
      `SELECT COUNT(*) as count FROM context_entries
       WHERE repo = ? AND key LIKE 'docs:%' AND updated_at < datetime('now', ?)`,
    )
    .get(repo, `-${staleDays} days`) as CountRow;

  const agg = db
    .prepare(
      `SELECT MIN(updated_at) as oldest, MAX(updated_at) as newest
       FROM context_entries WHERE repo = ? AND key LIKE 'docs:%'`,
    )
    .get(repo) as AggRow;

  const kindRows = db
    .prepare(
      `SELECT kind, COUNT(*) as count FROM context_entries
       WHERE repo = ? GROUP BY kind ORDER BY count DESC`,
    )
    .all(repo) as KindCountRow[];

  const byKind: Record<string, number> = {};
  for (const row of kindRows) {
    byKind[row.kind] = row.count;
  }

  const bytes = db
    .prepare(
      "SELECT COALESCE(SUM(LENGTH(content)), 0) as total_bytes FROM context_entries WHERE repo = ?",
    )
    .get(repo) as BytesRow;

  return {
    totalEntries: total.count,
    docEntries: docs.count,
    staleDocEntries: stale.count,
    oldestDocUpdate: agg.oldest,
    newestDocUpdate: agg.newest,
    byKind,
    totalContentBytes: bytes.total_bytes,
  };
}

// ---------------------------------------------------------------------------
// Purge stale web_docs entries
// ---------------------------------------------------------------------------

export interface PurgeResult {
  entriesRemoved: number;
  rawHashesRemoved: number;
}

/**
 * Delete doc context entries (keys starting with "docs:") and their
 * associated raw content hashes (keys starting with "_raw:docs:") that
 * haven't been updated in the given number of days.
 *
 * This extends the simpler pruneStaleDocEntries by also cleaning up
 * the raw-content tracking entries used for change detection.
 */
export function purgeStaleWebDocs(
  repo: string,
  olderThanDays: number = 30,
): PurgeResult {
  const db = getDb();
  const cutoff = `-${olderThanDays} days`;

  const result = db.transaction(() => {
    const docs = db
      .prepare(
        `DELETE FROM context_entries
         WHERE repo = ? AND key LIKE 'docs:%' AND updated_at < datetime('now', ?)`,
      )
      .run(repo, cutoff);

    const rawHashes = db
      .prepare(
        `DELETE FROM context_entries
         WHERE repo = ? AND key LIKE '_raw:docs:%' AND updated_at < datetime('now', ?)`,
      )
      .run(repo, cutoff);

    return {
      entriesRemoved: docs.changes,
      rawHashesRemoved: rawHashes.changes,
    };
  })();

  return result;
}
