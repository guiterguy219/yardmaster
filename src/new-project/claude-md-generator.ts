import { tmpdir } from "node:os";
import type { YardmasterConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import {
  CLAUDE_MD_GENERATOR_SYSTEM_PROMPT,
  buildClaudeMdGeneratorPrompt,
} from "../prompts/claude-md-generator.js";
import type { ProjectSpec } from "./types.js";

export async function generateClaudeMd(
  config: YardmasterConfig,
  spec: ProjectSpec
): Promise<string> {
  const result = await runAgent(config, {
    prompt: buildClaudeMdGeneratorPrompt(spec),
    systemPrompt: CLAUDE_MD_GENERATOR_SYSTEM_PROMPT,
    workingDir: tmpdir(),
    allowedTools: [],
    model: "sonnet",
    timeout: 2 * 60 * 1000,
  });

  if (!result.success) {
    throw new Error(`CLAUDE.md generator failed: ${result.error ?? "unknown error"}`);
  }

  const text = result.result.trim();
  if (!text) {
    throw new Error("CLAUDE.md generator returned empty output");
  }

  // If the agent wrapped the entire doc in a single fence, strip it.
  const fenceMatch = text.match(/^```(?:markdown|md)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```[ \t]*$/);
  return fenceMatch ? fenceMatch[1].trim() : text;
}
