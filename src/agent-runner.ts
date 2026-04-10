import { spawn, type ChildProcess } from "node:child_process";
import { type YardmasterConfig } from "./config.js";
import { recordCapacityEvent, type CapacityEvent } from "./capacity.js";

export interface AgentRunOptions {
  prompt: string;
  systemPrompt: string;
  workingDir: string;
  allowedTools?: string[];
  model?: string;
  timeout: number;
}

export interface AgentRunResult {
  success: boolean;
  result: string;
  durationMs: number;
  capacityEvent?: CapacityEvent;
  error?: string;
}

interface StreamJsonMessage {
  type: string;
  [key: string]: unknown;
}

export async function runAgent(
  config: YardmasterConfig,
  options: AgentRunOptions
): Promise<AgentRunResult> {
  const start = Date.now();
  const tools = options.allowedTools ?? [
    "Bash",
    "Edit",
    "Read",
    "Write",
    "Glob",
    "Grep",
  ];

  const args = [
    "-p", options.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model", options.model ?? config.defaultModel,
    "--allowedTools", tools.join(","),
  ];

  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  return new Promise<AgentRunResult>((resolve) => {
    const child: ChildProcess = spawn(config.claudeBinary, args, {
      cwd: options.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";
    let lastResult = "";
    let capacityEvent: CapacityEvent | undefined;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    }, options.timeout);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();

      // Parse newline-delimited JSON
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? ""; // keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as StreamJsonMessage;
          handleStreamMessage(msg);
        } catch {
          // not JSON, ignore
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    function handleStreamMessage(msg: StreamJsonMessage) {
      if (msg.type === "assistant" && typeof msg.message === "object") {
        const message = msg.message as { content?: Array<{ type: string; text?: string }> };
        if (message.content) {
          for (const block of message.content) {
            if (block.type === "text" && block.text) {
              lastResult = block.text;
            }
          }
        }
      }

      if (msg.type === "system" && msg.subtype === "rate_limit_event") {
        const info = msg.rate_limit_info as {
          resetsAt?: number;
          rateLimitType?: string;
          isUsingOverage?: boolean;
        } | undefined;
        if (info) {
          capacityEvent = {
            resetsAt: info.resetsAt ?? null,
            rateLimitType: info.rateLimitType ?? null,
            isUsingOverage: info.isUsingOverage ?? false,
          };
        }
      }

      // Also check for result message type
      if (msg.type === "result") {
        const resultMsg = msg as { result?: string };
        if (resultMsg.result) {
          lastResult = resultMsg.result;
        }
      }
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      // Process any remaining stdout
      if (stdout.trim()) {
        try {
          const msg = JSON.parse(stdout.trim()) as StreamJsonMessage;
          handleStreamMessage(msg);
        } catch {
          // ignore
        }
      }

      // Record capacity event if we got one
      if (capacityEvent) {
        recordCapacityEvent(capacityEvent);
      }

      if (killed) {
        resolve({
          success: false,
          result: lastResult,
          durationMs,
          capacityEvent,
          error: `Agent timed out after ${options.timeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          result: lastResult,
          durationMs,
          capacityEvent,
          error: stderr.trim() || `Agent exited with code ${code}`,
        });
        return;
      }

      resolve({
        success: true,
        result: lastResult,
        durationMs,
        capacityEvent,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        result: "",
        durationMs: Date.now() - start,
        error: `Failed to spawn agent: ${err.message}`,
      });
    });
  });
}
