import { execFileSync } from "node:child_process";

/**
 * Parse an issue reference string like "org/repo#123" into its components.
 * Returns null if the format is invalid.
 */
export function parseIssueRef(
  ref: string
): { owner: string; repo: string; number: number } | null {
  try {
    const match = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) return null;
    const num = parseInt(match[3], 10);
    if (!Number.isFinite(num) || num <= 0) return null;
    return { owner: match[1], repo: match[2], number: num };
  } catch {
    return null;
  }
}

/**
 * Add a comment to a GitHub issue. Best-effort — never throws.
 */
export function commentOnIssue(issueRef: string, body: string): void {
  try {
    const parsed = parseIssueRef(issueRef);
    if (!parsed) return;

    execFileSync(
      "gh",
      [
        "issue",
        "comment",
        String(parsed.number),
        "--repo", `${parsed.owner}/${parsed.repo}`,
        "--body", body,
      ],
      { encoding: "utf-8", stdio: "pipe" }
    );
  } catch {
    // Best effort — never throw
  }
}

/**
 * Add labels to a GitHub issue. Best-effort — never throws.
 */
export function updateIssueLabels(
  issueRef: string,
  labels: string[]
): void {
  try {
    if (labels.length === 0) return;
    const parsed = parseIssueRef(issueRef);
    if (!parsed) return;

    const args = [
      "issue", "edit",
      String(parsed.number),
      "--repo", `${parsed.owner}/${parsed.repo}`,
    ];
    for (const label of labels) {
      args.push("--add-label", label);
    }

    execFileSync("gh", args, { encoding: "utf-8", stdio: "pipe" });
  } catch {
    // Best effort — never throw
  }
}

/**
 * Notify an issue that a task has been queued for it. Best-effort — never throws.
 */
export function notifyQueued(issueRef: string, taskId: string): void {
  commentOnIssue(
    issueRef,
    `🤖 **Yardmaster** — Task queued\n\nTask \`${taskId}\` has been created and queued for processing.`
  );
  updateIssueLabels(issueRef, ["ym-queued"]);
}

/**
 * Notify an issue that work has started. Best-effort — never throws.
 */
export function notifyStarted(issueRef: string, taskId: string): void {
  commentOnIssue(
    issueRef,
    `🤖 **Yardmaster** — Work started\n\nTask \`${taskId}\` is now being worked on by an agent.`
  );
  updateIssueLabels(issueRef, ["ym-in-progress"]);
}

/**
 * Notify an issue that a PR has been created. Best-effort — never throws.
 */
export function notifyPrCreated(
  issueRef: string,
  taskId: string,
  prUrl: string
): void {
  commentOnIssue(
    issueRef,
    `🤖 **Yardmaster** — PR created\n\nTask \`${taskId}\` has a pull request ready for review: ${prUrl}`
  );
  updateIssueLabels(issueRef, ["ym-pr-created"]);
}

/**
 * Notify an issue that the task failed. Best-effort — never throws.
 */
export function notifyFailed(
  issueRef: string,
  taskId: string,
  error: string
): void {
  const truncatedError = error.length > 500
    ? `${error.slice(0, 497)}...`
    : error;
  commentOnIssue(
    issueRef,
    `🤖 **Yardmaster** — Task failed\n\nTask \`${taskId}\` failed:\n\n\`\`\`\n${truncatedError}\n\`\`\``
  );
  updateIssueLabels(issueRef, ["ym-failed"]);
}
