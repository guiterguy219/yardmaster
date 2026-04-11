import { execFileSync } from "node:child_process";
import { loadConfig, type RepoConfig, type YardmasterConfig } from "./config.js";
import { executeTask, type TaskResult } from "./task-runner.js";

export interface PrInfo {
  owner: string;
  repo: string;
  number: number;
}

export interface PrContext {
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  reviewComments: string[];
}

export function parsePrUrl(url: string): PrInfo {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid PR URL: ${url}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

export function fetchPrContext(pr: PrInfo): PrContext {
  const nwo = `${pr.owner}/${pr.repo}`;

  const prJson = execFileSync("gh", [
    "pr", "view", String(pr.number),
    "--repo", nwo,
    "--json", "title,body,headRefName,baseRefName",
  ], { encoding: "utf-8" });

  const prData = JSON.parse(prJson) as {
    title: string;
    body: string;
    headRefName: string;
    baseRefName: string;
  };

  let reviewComments: string[] = [];
  try {
    const commentsRaw = execFileSync("gh", [
      "api",
      `repos/${nwo}/pulls/${pr.number}/comments`,
      "--jq", "[.[] | select(.body != null) | .body]",
    ], { encoding: "utf-8" });

    const reviewsRaw = execFileSync("gh", [
      "api",
      `repos/${nwo}/pulls/${pr.number}/reviews`,
      "--jq", "[.[] | select(.body != null) | .body]",
    ], { encoding: "utf-8" });

    const comments = JSON.parse(commentsRaw.trim() || "[]") as string[];
    const reviews = JSON.parse(reviewsRaw.trim() || "[]") as string[];

    reviewComments = [...comments, ...reviews]
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // Best effort — PR may have no review comments
  }

  return {
    title: prData.title,
    body: prData.body,
    headRefName: prData.headRefName,
    baseRefName: prData.baseRefName,
    reviewComments,
  };
}

export function buildTaskFromPr(pr: PrInfo, context: PrContext): string {
  const lines: string[] = [
    `Address feedback on PR #${pr.number}: ${context.title}`,
  ];

  if (context.body) {
    lines.push("", "## Original PR Description", "", context.body);
  }

  if (context.reviewComments.length > 0) {
    lines.push("", "## Review Comments to Address", "");
    for (const comment of context.reviewComments) {
      lines.push("```", comment, "```", "");
    }
  }

  return lines.join("\n");
}

function findRepoConfig(config: YardmasterConfig, pr: PrInfo): RepoConfig {
  const match = config.repos.find(
    (r) => r.githubOrg === pr.owner && r.githubRepo === pr.repo
  );
  if (!match) {
    const available = config.repos
      .map((r) => `${r.githubOrg}/${r.githubRepo}`)
      .join(", ");
    throw new Error(
      `No configured repo matches ${pr.owner}/${pr.repo}. Available: ${available}`
    );
  }
  return match;
}

function commentOnPr(pr: PrInfo, followUpPrUrl: string): void {
  const nwo = `${pr.owner}/${pr.repo}`;
  const body = `A follow-up PR has been created to address review feedback: ${followUpPrUrl}`;
  execFileSync("gh", [
    "pr", "comment", String(pr.number),
    "--repo", nwo,
    "--body", body,
  ], { stdio: "pipe" });
}

export async function takeoverPr(prUrl: string): Promise<TaskResult> {
  const pr = parsePrUrl(prUrl);
  const config = loadConfig();
  const repo = findRepoConfig(config, pr);
  const context = fetchPrContext(pr);
  const description = buildTaskFromPr(pr, context);

  console.log(`  Taking over PR #${pr.number}: ${context.title}`);
  console.log(`  Branch: ${context.headRefName}`);

  const result = await executeTask(repo.name, description, {
    baseBranch: context.headRefName,
    targetBranch: context.baseRefName,
  });

  if (result.success && result.prUrl) {
    try {
      commentOnPr(pr, result.prUrl);
      console.log(`  Commented on original PR #${pr.number}`);
    } catch {
      console.log(`  Warning: failed to comment on original PR #${pr.number}`);
    }
  }

  return result;
}
