import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { createSerenaConfig } from "../serena.js";

// ---------------------------------------------------------------------------
// Skip guard: entire suite requires uvx on PATH
// ---------------------------------------------------------------------------

let uvxAvailable = false;
try {
  execSync("uvx --version", { stdio: "pipe" });
  uvxAvailable = true;
} catch {
  // uvx not installed — skip
}

// Helper to send JSON-RPC over stdin and read the response
function sendJsonRpc(
  child: ChildProcess,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for JSON-RPC response"));
    }, 15000);

    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      // MCP uses newline-delimited JSON
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          // Match by id for request/response, or accept any result
          if ("id" in message && parsed.id === message.id) {
            clearTimeout(timeout);
            child.stdout!.removeListener("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // Not JSON yet, keep buffering
        }
      }
      // Keep the last incomplete line in the buffer
      buffer = lines[lines.length - 1] ?? "";
    };

    child.stdout!.on("data", onData);

    const payload = JSON.stringify(message) + "\n";
    child.stdin!.write(payload);
  });
}

describe.skipIf(!uvxAvailable)("Serena MCP smoke test", () => {
  let configPath: string | undefined;
  let serverProcess: ChildProcess | undefined;

  afterEach(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      // Give it a moment then force kill
      setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill("SIGKILL");
        }
      }, 3000);
    }
    if (configPath && existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it("starts and responds to MCP initialize handshake", async () => {
    // Use Yardmaster's own repo as the project
    const projectPath = new URL("../../", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    configPath = createSerenaConfig(projectPath);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const serena = config.mcpServers.serena;

    serverProcess = spawn(serena.command, serena.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Collect stderr for diagnostics on failure
    let stderr = "";
    serverProcess.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Send MCP initialize
    const response = await sendJsonRpc(serverProcess, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "yardmaster-test",
          version: "0.1.0",
        },
      },
    });

    expect(response).toHaveProperty("result");
    const result = response.result as Record<string, unknown>;
    expect(result).toHaveProperty("serverInfo");
    expect(result).toHaveProperty("capabilities");

    // Send initialized notification (required by MCP protocol)
    serverProcess.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
  }, 60000); // 60s timeout — first uvx run may need to fetch the package

  it("exposes code navigation tools via tools/list", async () => {
    const projectPath = new URL("../../", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    configPath = createSerenaConfig(projectPath);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const serena = config.mcpServers.serena;

    serverProcess = spawn(serena.command, serena.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stderr = "";
    serverProcess.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Initialize first
    await sendJsonRpc(serverProcess, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "yardmaster-test", version: "0.1.0" },
      },
    });

    serverProcess.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );

    // Request tools list
    const toolsResponse = await sendJsonRpc(serverProcess, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(toolsResponse).toHaveProperty("result");
    const toolsResult = toolsResponse.result as {
      tools?: Array<{ name: string }>;
    };
    expect(toolsResult).toHaveProperty("tools");
    expect(Array.isArray(toolsResult.tools)).toBe(true);
    expect(toolsResult.tools!.length).toBeGreaterThan(0);

    // Serena should expose code navigation tools
    const toolNames = toolsResult.tools!.map((t) => t.name);
    expect(toolNames.length).toBeGreaterThan(0);
  }, 60000);
});
