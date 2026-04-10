import { scanReposForIssues } from "../issue-scanner.js";
import { closeQueue } from "./task-queue.js";

console.log("Yardmaster scan starting...");

let exitCode = 0;
try {
  const result = await scanReposForIssues();

  console.log(
    `Scan complete: ${result.queued} queued, ${result.skipped} skipped, ${result.errors.length} errors`
  );

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`  Error: ${err}`);
    }
    exitCode = 1;
  }
} finally {
  await closeQueue();
}
process.exit(exitCode);
