import type { YardmasterConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import {
  ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT,
  buildActionabilityPrompt,
} from "../prompts/actionability-classifier.js";

export interface ActionabilityResult {
  actionable: boolean;
  reason: string;
}

export async function classifyActionability(
  config: YardmasterConfig,
  title: string,
  body: string,
  labels: string[]
): Promise<ActionabilityResult> {
  const prompt = buildActionabilityPrompt(title, body, labels);

  try {
    const result = await runAgent(config, {
      prompt,
      systemPrompt: ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT,
      workingDir: process.cwd(),
      allowedTools: [],
      model: "haiku",
      timeout: 60_000,
    });

    if (!result.success) {
      return { actionable: true, reason: "" };
    }

    const parsed = JSON.parse(result.result) as ActionabilityResult;
    if (typeof parsed.actionable !== "boolean") {
      return { actionable: true, reason: "" };
    }

    return {
      actionable: parsed.actionable,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    // Fail open — treat as actionable on any error
    return { actionable: true, reason: "" };
  }
}
