import { getQueue } from "./task-queue.js";
import { getTerminalTaskByRepoAndDescription } from "../db.js";

/**
 * Scan BullMQ for jobs whose corresponding SQLite task has already reached
 * a terminal status (done, completed, failed, partial). These "zombie" jobs
 * would otherwise be re-processed, potentially shipping duplicate PRs.
 */
export async function removeZombieJobs(): Promise<{ removed: number }> {
  const queue = getQueue();
  const jobs = await queue.getJobs(["active", "waiting", "prioritized", "delayed"]);

  let removed = 0;
  for (const job of jobs) {
    const { repo, description } = job.data ?? {};
    if (!repo || !description) continue;

    const task = getTerminalTaskByRepoAndDescription(repo, description);
    if (task) {
      try {
        await job.remove();
        console.warn(
          `[Worker] Removed zombie job ${job.id} (task ${task.id} already ${task.status})`
        );
        removed++;
      } catch {
        // Job may have changed state between check and remove — safe to ignore.
      }
    }
  }

  return { removed };
}
