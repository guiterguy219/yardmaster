import type { YardmasterConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import {
  DIAGNOSTICIAN_SYSTEM_PROMPT,
  buildDiagnosticianPrompt,
  type DiagnosticContext,
  type DiagnosticResult,
  type DiagnosticCategory,
  type DiagnosticAction,
} from "../prompts/diagnostician.js";
import { parseAgentJson } from "../utils/parse-json.js";
import { logAgentRun } from "../db.js";

const VALID_CATEGORIES = new Set<DiagnosticCategory>([
  "environment",
  "gitignore",
  "task_spec",
  "pipeline_bug",
  "agent_behavior",
  "external",
  "unknown",
]);

const VALID_ACTION_TYPES = new Set<DiagnosticAction["type"]>(["retry", "retry_with_spec", "create_issue", "escalate", "give_up"]);

export async function runDiagnostician(
  config: YardmasterConfig,
  taskId: string,
  context: DiagnosticContext,
  model: "sonnet" | "opus" = "sonnet"
): Promise<DiagnosticResult> {
  const timeout = model === "opus"
    ? config.timeouts.diagnosticianEscalated
    : config.timeouts.diagnostician;

  const prompt = buildDiagnosticianPrompt(context);

  const result = await runAgent(config, {
    prompt,
    systemPrompt: DIAGNOSTICIAN_SYSTEM_PROMPT,
    workingDir: context.worktreePath,
    allowedTools: ["Bash", "Read", "Glob", "Grep"],
    model,
    timeout,
  });

  logAgentRun(
    taskId,
    `diagnostician-${model}`,
    0,
    `stage=${context.failureStage}`,
    result.result.slice(0, 500),
    result.durationMs,
    result.success
  );

  if (!result.success) {
    return {
      diagnosis: `Diagnostician (${model}) failed: ${result.error ?? "unknown error"}`,
      category: "unknown",
      action: { type: "give_up", reason: `Diagnostician agent failed: ${result.error ?? "unknown"}` },
    };
  }

  return parseDiagnosticOutput(result.result);
}

function parseDiagnosticOutput(text: string): DiagnosticResult {
  const parsed = parseAgentJson<DiagnosticResult>(text);
  if (!parsed) {
    return {
      diagnosis: "Could not parse diagnostician output",
      category: "unknown",
      action: { type: "give_up", reason: "Diagnostician output was not valid JSON" },
    };
  }

  // Validate and normalize
  const category: DiagnosticCategory = VALID_CATEGORIES.has(parsed.category as DiagnosticCategory)
    ? (parsed.category as DiagnosticCategory)
    : "unknown";

  const action = parsed.action;
  if (!action || !VALID_ACTION_TYPES.has(action.type)) {
    return {
      diagnosis: parsed.diagnosis ?? "Unknown",
      category,
      action: { type: "give_up", reason: "Invalid action type in diagnostician output" },
    };
  }

  return {
    diagnosis: parsed.diagnosis ?? "No diagnosis provided",
    category,
    action,
  };
}
