import type { YardmasterConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import { JUDGE_SYSTEM_PROMPT, buildJudgePrompt } from "../prompts/judge.js";

export interface JudgeDecision {
  issueDescription: string;
  verdict: "accept" | "fix";
  rationale: string;
  fix?: string;
}

export interface JudgeResult {
  decisions: JudgeDecision[];
  overallVerdict: "ship" | "fix_and_ship";
  summary: string;
}

export async function runJudge(
  config: YardmasterConfig,
  taskDescription: string,
  currentDiff: string,
  reviewHistory: string,
  unresolvedIssues: Array<{ severity: string; file: string; description: string; suggestion?: string }>,
  worktreePath: string
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(taskDescription, currentDiff, reviewHistory, unresolvedIssues);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    workingDir: worktreePath,
    allowedTools: ["Read", "Glob", "Grep"],
    model: "sonnet",
    timeout: 120_000,
  });

  if (!result.success) {
    return { decisions: [], overallVerdict: "ship", summary: "Judge failed — shipping as-is" };
  }

  return parseJudgeOutput(result.result);
}

function parseJudgeOutput(text: string): JudgeResult {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned) as JudgeResult;
    return {
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      overallVerdict: parsed.overallVerdict === "fix_and_ship" ? "fix_and_ship" : "ship",
      summary: parsed.summary ?? "",
    };
  } catch {
    return { decisions: [], overallVerdict: "ship", summary: "Judge output unparseable — shipping as-is" };
  }
}
