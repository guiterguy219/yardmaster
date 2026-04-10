import { readFileSync } from "fs";
import { Command } from "commander";
import { executeTask } from "./task-runner.js";
import { getRecentTasks } from "./db.js";
import { checkCapacity } from "./capacity.js";

const program = new Command();

program
  .name("ym")
  .description("Yardmaster — autonomous agent orchestration")
  .version("0.1.0");

program
  .command("task")
  .description("Run an autonomous coding task")
  .argument("[description]", "What the agent should do")
  .requiredOption("--repo <name>", "Target repository name (from repos.json)")
  .option("--file <path>", "Read task description from a file")
  .action(async (description: string | undefined, opts: { repo: string; file?: string }) => {
    let taskDescription = "";

    if (opts.file) {
      let contents = "";
      try {
        contents = readFileSync(opts.file, "utf-8").trim();
      } catch (err) {
        program.error(`cannot read file '${opts.file}': ${(err as NodeJS.ErrnoException).message}`);
      }
      if (!contents.length) {
        program.error(`file '${opts.file}' is empty`);
      }
      taskDescription = contents;
    } else if (description) {
      taskDescription = description;
    } else {
      program.error("provide a task description or use --file <path>");
    }

    console.log(`\nYardmaster — Task`);
    console.log(`  Repo: ${opts.repo}`);
    console.log(`  Task: ${taskDescription}\n`);

    const result = await executeTask(opts.repo, taskDescription);

    console.log();
    if (result.success) {
      console.log(`Done. ${result.prUrl ? `PR: ${result.prUrl}` : "Completed (no PR created)"}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show recent task history")
  .option("-n, --limit <number>", "Number of tasks to show", "10")
  .action((opts: { limit: string }) => {
    const tasks = getRecentTasks(parseInt(opts.limit, 10));

    if (tasks.length === 0) {
      console.log("No tasks yet.");
      return;
    }

    console.log(`\nRecent tasks:\n`);
    for (const task of tasks) {
      const status = formatStatus(task.status);
      const pr = task.pr_url ? ` -> ${task.pr_url}` : "";
      const err = task.error ? ` (${task.error})` : "";
      console.log(`  ${status} ${task.id}  ${task.repo}  ${task.description.slice(0, 60)}${pr}${err}`);
    }
    console.log();
  });

program
  .command("capacity")
  .description("Check current rate limit capacity")
  .action(() => {
    const cap = checkCapacity();
    console.log(`\nCapacity:`);
    console.log(`  Can proceed: ${cap.canProceed ? "yes" : "NO"}`);
    console.log(`  Using overage: ${cap.isUsingOverage ? "yes" : "no"}`);
    if (cap.resetsAt) {
      console.log(`  Resets at: ${cap.resetsAt.toISOString()}`);
    }
    if (cap.reason) {
      console.log(`  Note: ${cap.reason}`);
    }
    console.log();
  });

function formatStatus(status: string): string {
  switch (status) {
    case "completed": return "[done]";
    case "running":   return "[....]";
    case "failed":    return "[FAIL]";
    case "partial":   return "[part]";
    case "pending":   return "[wait]";
    default:          return `[${status}]`;
  }
}

program.parse();
