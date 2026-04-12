import type { YardmasterConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import {
  DIAGNOSTICIAN_SYSTEM_PROMPT,
  buildDiagnosticianPrompt,
  type DiagnosticContext,
} from "../prompts/diagnostician.js";
import { parseAgentJson } from "../utils/parse-json.js";

export type DiagnosticCategory =
  | "environment"
  | "gitignore"
  | "task_spec"
  | "pipeline_bug"
  | "agent_behavior"
  | "external"
  | "unknown";

export type DiagnosticAction =
  | { type: "retry"; fixes: string[] }
  | { type: "retry_with_spec"; newSpec: string }
  | { type: "create_issue"; title: string; body: string }
  | { type: "escalate"; reason: string }
  | { type: "give_up"; reason: string };

export interface DiagnosticResult {
  diagnosis: string;
  category: DiagnosticCategory;
  action: DiagnosticAction;
}

const VALID_CATEGORIES = new Set<string>([
  "environment",
  "gitignore",
  "task_spec",
  "pipeline_bug",
  "agent_behavior",
  "external",
  "unknown",
]);

const VALID_ACTIONS = new Set<string>([
  "retry",
  "retry_with_spec",
  "create_issue",
  "escalate",
  "give_up",
]);

export async function runDiagnostician(
  config: YardmasterConfig,
  context: DiagnosticContext,
  model: "sonnet" | "opus" = "sonnet"
): Promise<DiagnosticResult> {
  const timeout =
    model === "opus"
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

  if (!result.success) {
    return {
      diagnosis: `Diagnostician failed: ${result.error ?? "unknown error"}`,
      category: "unknown",
      action: { type: "give_up", reason: `Diagnostician agent failed: ${result.error}` },
    };
  }

  return parseDiagnosticOutput(result.result);
}

function parseDiagnosticOutput(text: string): DiagnosticResult {
  const parsed = parseAgentJson<DiagnosticResult>(text);
  if (!parsed) {
    return {
      diagnosis: text.slice(0, 500),
      category: "unknown",
      action: { type: "give_up", reason: "Diagnostician output was not valid JSON" },
    };
  }

  const category: DiagnosticCategory = VALID_CATEGORIES.has(parsed.category)
    ? (parsed.category as DiagnosticCategory)
    : "unknown";

  const action = validateAction(parsed.action);

  return {
    diagnosis: parsed.diagnosis ?? "No diagnosis provided",
    category,
    action,
  };
}

function validateAction(raw: unknown): DiagnosticAction {
  if (!raw || typeof raw !== "object" || !("type" in raw)) {
    return { type: "give_up", reason: "Invalid action in diagnostician output" };
  }

  const action = raw as Record<string, unknown>;
  if (!VALID_ACTIONS.has(action.type as string)) {
    return { type: "give_up", reason: `Unknown action type: ${action.type}` };
  }

  switch (action.type) {
    case "retry":
      return {
        type: "retry",
        fixes: Array.isArray(action.fixes) ? (action.fixes as string[]) : [],
      };
    case "retry_with_spec":
      return {
        type: "retry_with_spec",
        newSpec: typeof action.newSpec === "string" ? action.newSpec : "",
      };
    case "create_issue":
      return {
        type: "create_issue",
        title: typeof action.title === "string" ? action.title : "Pipeline failure",
        body: typeof action.body === "string" ? action.body : "No details provided",
      };
    case "escalate":
      return {
        type: "escalate",
        reason: typeof action.reason === "string" ? action.reason : "Needs deeper analysis",
      };
    case "give_up":
      return {
        type: "give_up",
        reason: typeof action.reason === "string" ? action.reason : "Unrecoverable",
      };
    default:
      return { type: "give_up", reason: "Unknown action type" };
  }
}
