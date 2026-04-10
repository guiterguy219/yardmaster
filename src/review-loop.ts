import { execSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { logAgentRun } from "./db.js";
import { logReviewRound } from "./diff-ledger.js";
import { detectOscillation } from "./oscillation.js";
import { runCoder } from "./agents/coder.js";
import { runStyleReviewer } from "./agents/style-reviewer.js";
import { runLogicReviewer } from "./agents/logic-reviewer.js";

export interface ReviewLoopResult {
  converged: boolean;
  rounds: number;
  finalVerdict: "approved" | "needs_human_review";
  issues: any[];
}

interface ReviewIssue {
  severity: "critical" | "major" | "minor" | "nit";
  file: string;
  line: number;
  description: string;
  suggestion?: string;
}

interface ReviewOutput {
  verdict: "approve" | "revise";
  issues: ReviewIssue[];
}

function parseReviewerOutput(result: string): ReviewOutput {
  let text = result.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text) as ReviewOutput;
    return {
      verdict: parsed.verdict === "approve" ? "approve" : "revise",
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch {
    return { verdict: "revise", issues: [] };
  }
}

function filterIssuesBySeverity(issues: ReviewIssue[], round: number): ReviewIssue[] {
  if (round <= 2) return issues;
  if (round === 3) return issues.filter((i) => i.severity === "major" || i.severity === "critical");
  return issues.filter((i) => i.severity === "critical");
}

function buildFeedbackPrompt(taskDescription: string, issues: ReviewIssue[]): string {
  const issueLines = issues
    .map(
      (i) =>
        `- [${i.severity.toUpperCase()}] ${i.file}:${i.line} — ${i.description}${
          i.suggestion ? ` (suggestion: ${i.suggestion})` : ""
        }`
    )
    .join("\n");

  return `${taskDescription}

## Review Feedback

The previous implementation was reviewed and the following issues were found. Please address all of them:

${issueLines}

Fix these issues in the existing code. Do not rewrite everything from scratch — make targeted fixes.`;
}

export async function runReviewLoop(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  taskDescription: string
): Promise<ReviewLoopResult> {
  const MAX_ROUNDS = 4;
  let currentPrompt = taskDescription;
  let allIssues: ReviewIssue[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Step 1: Run coder agent
    console.log(`  [Round ${round}] Running coder...`);
    const coderResult = await runCoder(config, repo, currentPrompt, worktreePath);

    logAgentRun(
      taskId,
      "coder",
      round,
      currentPrompt.slice(0, 500),
      coderResult.result.slice(0, 500),
      coderResult.durationMs,
      coderResult.success
    );

    if (!coderResult.success) {
      return {
        converged: false,
        rounds: round,
        finalVerdict: "needs_human_review",
        issues: allIssues,
      };
    }

    console.log(`  [Round ${round}] Coder completed in ${(coderResult.durationMs / 1000).toFixed(1)}s`);

    // Step 2: Get diff (coder edits files but doesn't commit, so stage and diff against HEAD)
    let diff = "";
    try {
      execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
      diff = execSync("git diff --cached", {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      diff = "";
    }

    // Step 3: Run style reviewer
    console.log(`  [Round ${round}] Running style reviewer...`);
    const styleResult = await runStyleReviewer(config, repo, diff, worktreePath);
    const styleParsed = parseReviewerOutput(styleResult.result);

    logAgentRun(
      taskId,
      "style",
      round,
      `Review diff (${diff.length} chars)`,
      styleResult.result.slice(0, 500),
      styleResult.durationMs,
      styleResult.success
    );
    logReviewRound(taskId, round, "style", styleParsed.verdict, styleParsed.issues, diff);

    // Step 4: Run logic reviewer
    console.log(`  [Round ${round}] Running logic reviewer...`);
    const logicResult = await runLogicReviewer(config, repo, diff, worktreePath);
    const logicParsed = parseReviewerOutput(logicResult.result);

    logAgentRun(
      taskId,
      "logic",
      round,
      `Review diff (${diff.length} chars)`,
      logicResult.result.slice(0, 500),
      logicResult.durationMs,
      logicResult.success
    );
    logReviewRound(taskId, round, "logic", logicParsed.verdict, logicParsed.issues, diff);

    // Step 5: Both approve?
    if (styleParsed.verdict === "approve" && logicParsed.verdict === "approve") {
      return {
        converged: true,
        rounds: round,
        finalVerdict: "approved",
        issues: [],
      };
    }

    // Collect issues from this round
    allIssues = [...styleParsed.issues, ...logicParsed.issues];

    // Step 6: Check oscillation
    const oscillation = detectOscillation(taskId, diff);
    if (oscillation.detected) {
      console.log(`  Oscillation detected: ${oscillation.reason}`);
      return {
        converged: false,
        rounds: round,
        finalVerdict: "needs_human_review",
        issues: allIssues,
      };
    }

    // Check round limit
    if (round >= MAX_ROUNDS) {
      return {
        converged: false,
        rounds: round,
        finalVerdict: "needs_human_review",
        issues: allIssues,
      };
    }

    // Step 7: Build feedback prompt and continue
    const filteredIssues = filterIssuesBySeverity(allIssues, round);
    currentPrompt = buildFeedbackPrompt(taskDescription, filteredIssues);
    console.log(
      `  [Round ${round}] Revisions needed (${filteredIssues.length} issues), retrying...`
    );
  }

  return {
    converged: false,
    rounds: MAX_ROUNDS,
    finalVerdict: "needs_human_review",
    issues: allIssues,
  };
}
