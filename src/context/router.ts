import { getDb } from "../db.js";
import type { ContextKind } from "../context-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRole =
  | "coder"
  | "style-reviewer"
  | "logic-reviewer"
  | "planner"
  | "tools-agent"
  | "test-quality"
  | "integration-test";

export const ALL_AGENT_ROLES: AgentRole[] = ["coder", "style-reviewer", "logic-reviewer", "planner", "tools-agent", "test-quality", "integration-test"];

interface ContextRow {
  id: number;
  repo: string;
  kind: string;
  key: string;
  content: string;
  agent_roles: string;
  updated_at: string;
}

interface FormattedSection {
  kind: ContextKind;
  key: string;
  body: string;
  charCost: number;
}

// ---------------------------------------------------------------------------
// Character budgets per agent role
// ---------------------------------------------------------------------------

// Margin reserved for truncation suffix ("…\n" + safety buffer)
const TRUNCATION_MARGIN = 20;

const AGENT_BUDGETS: Record<AgentRole, number> = {
  coder: 4096,
  "style-reviewer": 2048,
  "logic-reviewer": 3072,
  planner: 2048,
  "tools-agent": 1024,
  "test-quality": 2048,
  "integration-test": 3072,
};

// Priority order for context kinds — higher-priority kinds are included first
const KIND_PRIORITY: ContextKind[] = [
  "convention",
  "snippet",
  "note",
  "file",
  "dependency",
];

// ---------------------------------------------------------------------------
// Section formatting
// ---------------------------------------------------------------------------

const KIND_HEADERS: Record<ContextKind, string> = {
  convention: "Conventions",
  snippet: "Code Snippets",
  note: "Notes",
  file: "Files",
  dependency: "Dependencies",
};

function formatSection(kind: ContextKind, key: string, content: string): FormattedSection {
  let body: string;

  if (kind === "dependency") {
    // Dependencies are stored as JSON; format compactly
    try {
      const dep = JSON.parse(content) as { name: string; version: string; dev: boolean };
      body = `- \`${dep.name}@${dep.version}\`${dep.dev ? " (dev)" : ""}`;
    } catch {
      body = `- ${key}: ${content}`;
    }
  } else {
    // For other kinds, use the key as a sub-header with content below
    body = `### ${key}\n\n${content}`;
  }

  return { kind, key, body, charCost: body.length + 1 }; // +1 for newline separator
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Fetch context entries for a given repo that are relevant to the specified
 * agent role. An entry matches if its agent_roles array contains the role
 * or is empty (applies to all roles).
 *
 * Results are sorted by updated_at DESC (most recently updated first) to
 * ensure deterministic, recency-biased ordering.
 */
function queryEntriesForRole(repo: string, role: AgentRole): ContextRow[] {
  const db = getDb();

  // Fetch entries that either target this specific role or target all roles
  // (empty array). SQLite LIKE is used for lightweight JSON array filtering.
  const rows = db
    .prepare(
      `SELECT id, repo, kind, key, content, agent_roles, updated_at
       FROM context_entries
       WHERE repo = ?
         AND (agent_roles LIKE ? OR agent_roles = '[]')
       ORDER BY updated_at DESC`
    )
    .all(repo, `%"${role}"%`) as ContextRow[];

  return rows;
}

// ---------------------------------------------------------------------------
// Core router
// ---------------------------------------------------------------------------

/**
 * Build a formatted context string for a specific agent role, fitting within
 * that role's character budget.
 *
 * Selection algorithm (deterministic):
 * 1. Query all entries matching the role (targeted + universal)
 * 2. Group by context kind
 * 3. Iterate kinds in priority order (conventions first, dependencies last)
 * 4. Within each kind, entries are ordered by recency (updated_at DESC)
 * 5. Greedily pack entries until the budget is exhausted
 *
 * Returns an empty string if no context is available or the repo has no
 * matching entries.
 */
export function getContextForAgent(
  role: AgentRole,
  repo: string,
  budgetOverride?: number,
): string {
  const budget = budgetOverride ?? AGENT_BUDGETS[role];
  const rows = queryEntriesForRole(repo, role);

  if (rows.length === 0) return "";

  // Group rows by kind
  const byKind = new Map<ContextKind, ContextRow[]>();
  for (const row of rows) {
    const kind = row.kind as ContextKind;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(row);
  }

  // Build sections in priority order, tracking remaining budget
  let remaining = budget;
  const outputSections: string[] = [];
  const sectionSeparator = "\n\n";

  for (const kind of KIND_PRIORITY) {
    const kindRows = byKind.get(kind);
    if (!kindRows || kindRows.length === 0) continue;

    const header = `## ${KIND_HEADERS[kind]}`;
    const headerCost = header.length + sectionSeparator.length;

    // Check if we can fit at least the header + one entry
    if (remaining < headerCost + TRUNCATION_MARGIN) break;

    const entries: FormattedSection[] = [];
    let kindCost = headerCost;

    for (const row of kindRows) {
      const section = formatSection(kind, row.key, row.content);

      if (kindCost + section.charCost > remaining) {
        // Try to fit a truncated version for non-dependency entries
        if (kind !== "dependency") {
          const available = remaining - kindCost - TRUNCATION_MARGIN;
          if (available > 80) {
            const truncatedBody = `### ${row.key}\n\n${row.content.slice(0, available)}…`;
            entries.push({ kind, key: row.key, body: truncatedBody, charCost: truncatedBody.length + 1 });
            kindCost += truncatedBody.length + 1;
          }
        }
        break;
      }

      entries.push(section);
      kindCost += section.charCost;
    }

    if (entries.length > 0) {
      const separator = kind === "dependency" ? "\n" : "\n\n";
      const section = `${header}\n\n${entries.map((e) => e.body).join(separator)}`;
      outputSections.push(section);
      remaining -= section.length + sectionSeparator.length;
    }
  }

  if (outputSections.length === 0) return "";

  return outputSections.join(sectionSeparator);
}

/**
 * Convenience: get the character budget for a given agent role.
 */
export function getBudgetForRole(role: AgentRole): number {
  return AGENT_BUDGETS[role];
}

/**
 * Get a summary of how much context is available vs. the budget for a role.
 * Useful for diagnostics / CLI stats.
 */
export function getContextStats(
  role: AgentRole,
  repo: string,
): { budget: number; entriesAvailable: number; formattedLength: number } {
  const budget = AGENT_BUDGETS[role];
  const rows = queryEntriesForRole(repo, role);
  const formatted = getContextForAgent(role, repo);

  return {
    budget,
    entriesAvailable: rows.length,
    formattedLength: formatted.length,
  };
}
