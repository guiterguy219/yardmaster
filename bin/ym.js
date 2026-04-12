#!/usr/bin/env node
// Ensure a generous V8 heap when invoked directly (mirrors yardmaster.service).
// --max-old-space-size must be set before V8 initializes, so re-exec if needed.
if (!process.env.YM_HEAP_CONFIGURED) {
  const { spawn } = await import("node:child_process");
  const existing = (process.env.NODE_OPTIONS ?? "").trim();
  const nodeOptions = [existing, "--max-old-space-size=4096", "--heapsnapshot-near-heap-limit=3"].filter(Boolean).join(" ");
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: nodeOptions, YM_HEAP_CONFIGURED: "1" },
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import("../src/cli.js");
}
