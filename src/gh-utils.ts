import { execSync } from "node:child_process";
import { ghExecEnv, orgFromIssueRef } from "./gh-auth.js";

interface GitHubIssueView {
  title: string;
  body: string;
  state: string;
  comments: Array<{ body: string; author: { login: string }; createdAt: string }>;
}

export interface FreshIssueResult {
  description: string;
  closed: boolean;
}

/**
 * Re-fetch a GitHub issue (title + body + comments) at worker pickup time
 * so the agent sees the latest context, not the stale payload from enqueue.
 *
 * Returns `closed: true` if the issue was closed between enqueue and pickup.
 * Falls back to the original description on any failure.
 */
export function fetchFreshIssue(
  issueRef: string,
  fallbackDescription: string
): FreshIssueResult {
  const org = orgFromIssueRef(issueRef);

  try {
    const raw = execSync(
      `gh issue view "${issueRef}" --json title,body,state,comments`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: ghExecEnv(org ?? ""),
        timeout: 15_000,
      }
    );

    const issue = JSON.parse(raw) as GitHubIssueView;

    if (issue.state === "CLOSED") {
      return { description: fallbackDescription, closed: true };
    }

    // Build description from fresh title + body + comments
    let description = `${issue.title}\n\n${issue.body ?? ""}`;

    if (issue.comments?.length) {
      const commentBlock = issue.comments
        .map(
          (c) =>
            `--- Comment by @${c.author.login} (${c.createdAt}) ---\n${c.body}`
        )
        .join("\n\n");
      description += `\n\n## Issue Comments\n\n${commentBlock}`;
    }

    description += `\n\nCloses ${issueRef}`;

    return { description, closed: false };
  } catch (err) {
    console.warn(
      `[Worker] Failed to re-fetch ${issueRef}, using queued description: ${(err as Error).message}`
    );
    return { description: fallbackDescription, closed: false };
  }
}
