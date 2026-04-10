import { execSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { logAgentRun } from "./db.js";
import { logReviewRound, getReviewHistory } from "./diff-ledger.js";
import { parseAgentJson } from "./utils/parse-json.js";
import { detectOscillation } from "./oscillation.js";
import { runCoder } from "./agents/coder.js";
import { runStyleReviewer } from "./agents/style-reviewer.js";
import { runLogicReviewer } from "./agents/logic-reviewer.js";
import { runToolsAgent } from "./agents/tools-agent.js";
import { runPlanner, type SubTask } from "./agents/planner.js";
import { runJudge } from "./agents/judge.js";
import { checkAlignment } from "./alignment-gate.js";

export interface ReviewLoopResult {
  converged: boolean;
  rounds: number;
  finalVerdict: "approved" | "needs_human_review" | "judge_approved";
  issues: any[];
  reviewSummary: string;
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
  const parsed = parseAgentJson<ReviewOutput>(result);
  if (!parsed) {
    return { verdict: "revise", issues: [] };
  }
  return {
    verdict: parsed.verdict === "approve" ? "approve" : "revise",
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
  };
}

function filterIssuesBySeverity(issues: ReviewIssue[], round: number): ReviewIssue[] {
  if (round <= 2) return issues;
  if (round === 3) return issues.filter((i) => i.severity === "major" || i.severity === "critical");
  return issues.filter((i) => i.severity === "critical");
}

async function applyAlignmentFilter(
  config: YardmasterConfig,
  parsed: ReviewOutput,
  agentName: string,
  taskDescription: string,
  taskId: string,
  round: number
): Promise<ReviewOutput> {
  const alignment = await checkAlignment(
    config,
    taskDescription,
    agentName,
    JSON.stringify(parsed.issues)
  );
  logAgentRun(
    taskId,
    "alignment",
    round,
    `Alignment check for ${agentName}`,
    JSON.stringify(alignment).slice(0, 500),
    0,
    alignment.aligned
  );
  if (!alignment.aligned && !alignment.filteredOutput) {
    console.warn(`  [Round ${round}] Alignment gate flagged ${agentName} as misaligned: ${alignment.concern}`);
    return { verdict: "approve", issues: [] };
  }
  if (alignment.aligned && alignment.filteredOutput) {
    try {
      const filtered = JSON.parse(alignment.filteredOutput);
      if (Array.isArray(filtered)) {
        const filteredIssues = filtered as ReviewIssue[];
        return {
          issues: filteredIssues,
          verdict: filteredIssues.length === 0 ? "approve" : parsed.verdict,
        };
      }
    } catch {
      // keep original issues if parse fails
    }
  }
  return parsed;
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

/**
 * Build a summary of prior round issues for reviewer context.
 * Tells reviewers what was already raised and resolved so they don't re-raise it.
 */
function buildPriorRoundsContext(taskId: string, currentRound: number): string {
  if (currentRound <= 1) return "";

  const history = getReviewHistory(taskId);
  const priorEntries = history.filter((h) => h.round < currentRound);

  if (priorEntries.length === 0) return "";

  const lines: string[] = [];
  for (const entry of priorEntries) {
    const issues = JSON.parse(entry.issues_json) as ReviewIssue[];
    if (issues.length === 0) continue;
    lines.push(`Round ${entry.round} (${entry.agent}): ${entry.verdict}`);
    for (const issue of issues) {
      lines.push(`  - [${issue.severity}] ${issue.file}: ${issue.description} → RESOLVED`);
    }
  }

  return lines.join("\n");
}

/**
 * Run a single sub-task through the coder + review cycle.
 * Returns the review result for this sub-task.
 */
async function runSubTaskReviewLoop(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  subTaskDescription: string,
  originalTaskDescription: string,
  subTaskIndex: number,
  totalSubTasks: number,
  toolsContext: string
): Promise<{ converged: boolean; rounds: number; roundSummaries: string[]; issues: ReviewIssue[]; judgeUsed: boolean }> {
  const MAX_ROUNDS = 4;
  const prefix = totalSubTasks > 1 ? `[${subTaskIndex + 1}/${totalSubTasks}]` : "";
  let currentPrompt = toolsContext ? `## Tools & Libraries\n\n${toolsContext}\n\n${subTaskDescription}` : subTaskDescription;
  let allIssues: ReviewIssue[] = [];
  const roundSummaries: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Step 1: Run coder
    console.log(`  ${prefix} [Round ${round}] Running coder...`);
    const coderResult = await runCoder(config, repo, currentPrompt, worktreePath);

    logAgentRun(taskId, "coder", round, currentPrompt.slice(0, 500), coderResult.result.slice(0, 500), coderResult.durationMs, coderResult.success);

    if (!coderResult.success || !coderResult.result) {
      roundSummaries.push(`- Round ${round}: coder failed`);
      return { converged: false, rounds: round, roundSummaries, issues: allIssues, judgeUsed: false };
    }

    console.log(`  ${prefix} [Round ${round}] Coder completed in ${(coderResult.durationMs / 1000).toFixed(1)}s`);

    // Step 2: Get diff
    let diff = "";
    try {
      execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
      diff = execSync("git diff --cached", { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      diff = "";
    }

    // Step 3: Build prior rounds context for reviewers
    const priorContext = buildPriorRoundsContext(taskId, round);

    // Step 4: Run style reviewer
    console.log(`  ${prefix} [Round ${round}] Running style reviewer...`);
    const styleResult = await runStyleReviewer(config, repo, diff, worktreePath, priorContext);
    let styleParsed = parseReviewerOutput(styleResult.result);

    logAgentRun(taskId, "style", round, `Review diff (${diff.length} chars)`, styleResult.result.slice(0, 500), styleResult.durationMs, styleResult.success);

    const styleBeforeCount = styleParsed.issues.length;
    styleParsed = await applyAlignmentFilter(config, styleParsed, "style", originalTaskDescription, taskId, round);
    const styleFilteredCount = styleBeforeCount - styleParsed.issues.length;

    logReviewRound(taskId, round, "style", styleParsed.verdict, styleParsed.issues, diff);

    // Step 5: Run logic reviewer
    console.log(`  ${prefix} [Round ${round}] Running logic reviewer...`);
    const logicResult = await runLogicReviewer(config, repo, diff, worktreePath, priorContext);
    let logicParsed = parseReviewerOutput(logicResult.result);

    logAgentRun(taskId, "logic", round, `Review diff (${diff.length} chars)`, logicResult.result.slice(0, 500), logicResult.durationMs, logicResult.success);

    const logicBeforeCount = logicParsed.issues.length;
    logicParsed = await applyAlignmentFilter(config, logicParsed, "logic", originalTaskDescription, taskId, round);
    const logicFilteredCount = logicBeforeCount - logicParsed.issues.length;

    logReviewRound(taskId, round, "logic", logicParsed.verdict, logicParsed.issues, diff);

    // Build summary
    const filterParts: string[] = [];
    if (styleFilteredCount > 0) filterParts.push(`style alignment filtered ${styleFilteredCount}`);
    if (logicFilteredCount > 0) filterParts.push(`logic alignment filtered ${logicFilteredCount}`);
    const filterNote = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";
    const roundBase = `- Round ${round}: style=${styleParsed.verdict} (${styleParsed.issues.length} issues), logic=${logicParsed.verdict} (${logicParsed.issues.length} issues)${filterNote}`;

    // Both approve?
    if (styleParsed.verdict === "approve" && logicParsed.verdict === "approve") {
      roundSummaries.push(`${roundBase} — converged`);
      return { converged: true, rounds: round, roundSummaries, issues: [], judgeUsed: false };
    }

    // Smart convergence: if only minor/nit issues after round 2, accept
    allIssues = [...styleParsed.issues, ...logicParsed.issues];
    if (round >= 2) {
      const hasCriticalOrMajor = allIssues.some((i) => i.severity === "critical" || i.severity === "major");
      if (!hasCriticalOrMajor) {
        roundSummaries.push(`${roundBase} — accepted (minor issues only after round ${round})`);
        return { converged: true, rounds: round, roundSummaries, issues: allIssues, judgeUsed: false };
      }
    }

    // Check oscillation — escalate to judge instead of halting
    const oscillation = detectOscillation(taskId, diff);
    if (oscillation.detected) {
      console.log(`  ${prefix} Oscillation detected — escalating to judge...`);
      roundSummaries.push(`${roundBase} — oscillation, escalating to judge`);

      const reviewHistory = buildPriorRoundsContext(taskId, round + 1);
      const judgeResult = await runJudge(config, originalTaskDescription, diff, reviewHistory, allIssues, worktreePath);

      logAgentRun(taskId, "judge", round, "Resolving oscillation", judgeResult.summary.slice(0, 500), 0, true);
      console.log(`  ${prefix} Judge ruling: ${judgeResult.overallVerdict} — ${judgeResult.summary}`);
      roundSummaries.push(`- Judge: ${judgeResult.overallVerdict} — ${judgeResult.summary}`);

      // If judge says ship, we're done
      if (judgeResult.overallVerdict === "ship") {
        return { converged: true, rounds: round, roundSummaries, issues: [], judgeUsed: true };
      }

      // If judge says fix_and_ship, apply fixes via one more coder call then ship
      const fixPrompts = judgeResult.decisions
        .filter((d) => d.verdict === "fix" && d.fix)
        .map((d) => `- ${d.issueDescription}: ${d.fix}`)
        .join("\n");

      if (fixPrompts) {
        console.log(`  ${prefix} Applying judge-ordered fixes...`);
        const fixResult = await runCoder(config, repo, `Apply these exact fixes:\n\n${fixPrompts}`, worktreePath);
        logAgentRun(taskId, "coder", round, "Judge-ordered fixes", fixResult.result.slice(0, 500), fixResult.durationMs, fixResult.success);
      }

      return { converged: true, rounds: round, roundSummaries, issues: [], judgeUsed: true };
    }

    // Check round limit — escalate to judge instead of halting
    if (round >= MAX_ROUNDS) {
      console.log(`  ${prefix} Max rounds reached — escalating to judge...`);
      roundSummaries.push(roundBase);

      const reviewHistory = buildPriorRoundsContext(taskId, round + 1);
      const judgeResult = await runJudge(config, originalTaskDescription, diff, reviewHistory, allIssues, worktreePath);

      logAgentRun(taskId, "judge", round, "Resolving max rounds", judgeResult.summary.slice(0, 500), 0, true);
      console.log(`  ${prefix} Judge ruling: ${judgeResult.overallVerdict} — ${judgeResult.summary}`);
      roundSummaries.push(`- Judge: ${judgeResult.overallVerdict} — ${judgeResult.summary}`);

      if (judgeResult.overallVerdict === "ship") {
        return { converged: true, rounds: round, roundSummaries, issues: [], judgeUsed: true };
      }

      const fixPrompts = judgeResult.decisions
        .filter((d) => d.verdict === "fix" && d.fix)
        .map((d) => `- ${d.issueDescription}: ${d.fix}`)
        .join("\n");

      if (fixPrompts) {
        console.log(`  ${prefix} Applying judge-ordered fixes...`);
        const fixResult = await runCoder(config, repo, `Apply these exact fixes:\n\n${fixPrompts}`, worktreePath);
        logAgentRun(taskId, "coder", round, "Judge-ordered fixes", fixResult.result.slice(0, 500), fixResult.durationMs, fixResult.success);
      }

      return { converged: true, rounds: round, roundSummaries, issues: [], judgeUsed: true };
    }

    roundSummaries.push(roundBase);

    // Build feedback and continue
    const filteredIssues = filterIssuesBySeverity(allIssues, round);
    currentPrompt = buildFeedbackPrompt(subTaskDescription, filteredIssues);
    console.log(`  ${prefix} [Round ${round}] Revisions needed (${filteredIssues.length} issues), retrying...`);
  }

  return { converged: false, rounds: MAX_ROUNDS, roundSummaries, issues: allIssues, judgeUsed: false };
}

export async function runReviewLoop(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  taskDescription: string
): Promise<ReviewLoopResult> {
  // Step 1: Run tools agent
  let toolsContext = "";
  console.log(`  Running tools advisor...`);
  try {
    toolsContext = await runToolsAgent(config, repo, taskDescription, worktreePath);
    logAgentRun(taskId, "tools", 0, taskDescription.slice(0, 500), toolsContext.slice(0, 500), 0, toolsContext.length > 0);
  } catch (err) {
    console.warn(`  Tools advisor failed, proceeding without recommendations: ${err}`);
  }

  // Step 2: Run planner to decompose task
  console.log(`  Running planner...`);
  let subTasks: SubTask[];
  try {
    subTasks = await runPlanner(config, repo, taskDescription, worktreePath);
    logAgentRun(taskId, "planner", 0, taskDescription.slice(0, 500), JSON.stringify(subTasks).slice(0, 500), 0, true);
  } catch {
    subTasks = [{ description: taskDescription, files: [], reason: "planner failed — using original task" }];
  }

  if (subTasks.length > 1) {
    console.log(`  Planner decomposed task into ${subTasks.length} sub-tasks:`);
    for (let i = 0; i < subTasks.length; i++) {
      console.log(`    ${i + 1}. ${subTasks[i].description.slice(0, 80)}`);
    }
  }

  // Step 3: Run each sub-task through the review loop
  const allSummaries: string[] = [];
  let totalRounds = 0;
  let judgeUsed = false;

  for (let i = 0; i < subTasks.length; i++) {
    const subTask = subTasks[i];
    if (subTasks.length > 1) {
      console.log(`\n  --- Sub-task ${i + 1}/${subTasks.length}: ${subTask.description.slice(0, 60)} ---`);
    }

    const result = await runSubTaskReviewLoop(
      config, repo, taskId, worktreePath,
      subTask.description, taskDescription,
      i, subTasks.length, toolsContext.trim()
    );

    totalRounds += result.rounds;
    judgeUsed = judgeUsed || result.judgeUsed;
    if (subTasks.length > 1) {
      allSummaries.push(`### Sub-task ${i + 1}: ${subTask.description.slice(0, 60)}`);
    }
    allSummaries.push(...result.roundSummaries);

    if (!result.converged) {
      return {
        converged: false,
        rounds: totalRounds,
        finalVerdict: "needs_human_review",
        issues: result.issues,
        reviewSummary: `Did not converge\n\n${allSummaries.join("\n")}`,
      };
    }
  }

  return {
    converged: true,
    rounds: totalRounds,
    finalVerdict: judgeUsed ? "judge_approved" : "approved",
    issues: [],
    reviewSummary: `${judgeUsed ? "Judge-approved" : "Converged"} after ${totalRounds} total round(s)${subTasks.length > 1 ? ` across ${subTasks.length} sub-tasks` : ""}\n\n${allSummaries.join("\n")}`,
  };
}
