import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { YardmasterConfig } from "../config.js";
import { runAgent } from "../agent-runner.js";
import { parseAgentJson } from "../utils/parse-json.js";
import { DISCOVERY_SYSTEM_PROMPT, buildDiscoveryPrompt } from "../prompts/discovery.js";
import { SPEC_EXTRACTOR_SYSTEM_PROMPT } from "../prompts/spec-extractor.js";
import { buildSpecExtractorPrompt } from "../prompts/spec-extractor.js";
import type { ProjectSpec } from "./types.js";

export async function runDiscovery(config: YardmasterConfig): Promise<ProjectSpec> {
  const result = await runAgent(config, {
    prompt: buildDiscoveryPrompt(),
    systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    workingDir: tmpdir(),
    allowedTools: [],
    model: "sonnet",
    timeout: 3 * 60 * 1000,
  });

  if (!result.success) {
    throw new Error(`Discovery agent failed: ${result.error ?? "unknown error"}`);
  }

  const spec = parseAgentJson<ProjectSpec>(result.result);
  if (!spec) {
    throw new Error(`Discovery agent did not produce a valid ProjectSpec JSON. Output:\n${result.result}`);
  }

  return spec;
}

export async function extractSpecFromFile(
  config: YardmasterConfig,
  filePath: string
): Promise<ProjectSpec> {
  const content = readFileSync(filePath, "utf-8");

  // Fast path: file already contains raw JSON
  const direct = parseAgentJson<ProjectSpec>(content);
  if (direct && typeof direct.name === "string" && typeof direct.framework === "string") {
    return direct;
  }

  const result = await runAgent(config, {
    prompt: buildSpecExtractorPrompt(content, filePath),
    systemPrompt: SPEC_EXTRACTOR_SYSTEM_PROMPT,
    workingDir: tmpdir(),
    allowedTools: [],
    model: "haiku",
    timeout: 60 * 1000,
  });

  if (!result.success) {
    throw new Error(`Spec extraction agent failed: ${result.error ?? "unknown error"}`);
  }

  const spec = parseAgentJson<ProjectSpec>(result.result);
  if (!spec) {
    throw new Error(`Spec extraction agent did not produce a valid ProjectSpec JSON. Output:\n${result.result}`);
  }

  return spec;
}
