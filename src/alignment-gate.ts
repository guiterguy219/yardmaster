import type { YardmasterConfig } from "./config.js";
import { runAgent } from "./agent-runner.js";
import { ALIGNMENT_SYSTEM_PROMPT, buildAlignmentPrompt } from "./prompts/alignment-gate.js";

export interface AlignmentResult {
  aligned: boolean;
  filteredOutput?: string;
  concern?: string;
}

function parseAlignmentResponse(result: string): AlignmentResult {
  let text = result.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text) as AlignmentResult;
    if (typeof parsed.aligned !== "boolean") {
      return { aligned: false, concern: "alignment check failed" };
    }
    return {
      aligned: parsed.aligned,
      filteredOutput: parsed.filteredOutput,
      concern: parsed.concern,
    };
  } catch {
    return { aligned: false, concern: "alignment check failed" };
  }
}

export async function checkAlignment(
  config: YardmasterConfig,
  taskDescription: string,
  agentName: string,
  agentOutput: string
): Promise<AlignmentResult> {
  try {
    const result = await runAgent(config, {
      prompt: buildAlignmentPrompt(taskDescription, agentName, agentOutput),
      systemPrompt: ALIGNMENT_SYSTEM_PROMPT,
      workingDir: process.cwd(),
      allowedTools: [],
      model: "haiku",
      timeout: 60_000,
    });

    if (!result.success || !result.result) {
      return { aligned: false, concern: "alignment check failed" };
    }

    return parseAlignmentResponse(result.result);
  } catch {
    return { aligned: false, concern: "alignment check failed" };
  }
}
