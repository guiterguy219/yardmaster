import type { YardmasterConfig } from "./config.js";
import { runAgent } from "./agent-runner.js";
import { ALIGNMENT_SYSTEM_PROMPT, buildAlignmentPrompt } from "./prompts/alignment-gate.js";
import { parseAgentJson } from "./utils/parse-json.js";

export interface AlignmentResult {
  aligned: boolean;
  filteredOutput?: string;
  concern?: string;
}

function parseAlignmentResponse(result: string): AlignmentResult {
  const parsed = parseAgentJson<AlignmentResult>(result);
  if (!parsed || typeof parsed.aligned !== "boolean") {
    return { aligned: true };
  }
  return {
    aligned: parsed.aligned,
    filteredOutput: parsed.filteredOutput,
    concern: parsed.concern,
  };
}

export async function checkAlignment(
  config: YardmasterConfig,
  taskDescription: string,
  agentName: string,
  agentOutput: string,
  diff?: string,
): Promise<AlignmentResult> {
  try {
    const result = await runAgent(config, {
      prompt: buildAlignmentPrompt(taskDescription, agentName, agentOutput, diff),
      systemPrompt: ALIGNMENT_SYSTEM_PROMPT,
      workingDir: process.cwd(),
      allowedTools: [],
      model: "haiku",
      timeout: 60_000,
    });

    if (!result.success || !result.result) {
      return { aligned: true };
    }

    return parseAlignmentResponse(result.result);
  } catch {
    return { aligned: true };
  }
}
