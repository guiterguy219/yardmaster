import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Write a temporary MCP config file for Serena and return its path.
 * Claude Code manages the Serena subprocess lifecycle automatically when
 * --mcp-config is passed — no manual spawn needed.
 */
export function createSerenaConfig(worktreePath: string): string {
  const tempConfigPath = join(tmpdir(), `ym-serena-${Date.now()}-${process.pid}.json`);
  const mcpConfig = {
    mcpServers: {
      serena: {
        type: "stdio",
        command: "uvx",
        args: [
          "--from",
          "git+https://github.com/oraios/serena@v1.0.0",
          "serena",
          "start-mcp-server",
          "--context",
          "ide-assistant",
          "--project",
          worktreePath,
        ],
      },
    },
  };
  writeFileSync(tempConfigPath, JSON.stringify(mcpConfig, null, 2));
  return tempConfigPath;
}

/**
 * Remove the temporary Serena MCP config file.
 */
export function cleanupSerenaConfig(tempConfigPath: string): void {
  if (existsSync(tempConfigPath)) {
    try {
      unlinkSync(tempConfigPath);
    } catch {
      // best-effort cleanup
    }
  }
}
