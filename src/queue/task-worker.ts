import { Worker, type Job } from "bullmq";
import { REDIS_CONNECTION, QUEUE_NAME } from "./connection.js";
import { PRIORITY_LABELS, type PriorityLevel } from "./constants.js";
import { executeTask } from "../task-runner.js";

interface TaskJobData {
  repo: string;
  description: string;
  priority: PriorityLevel;
  source: string;
  issueRef?: string;
  queuedAt: number;
}

export function startWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job<TaskJobData>) => {
      const { repo, description, priority, source, issueRef } = job.data;
      const label = PRIORITY_LABELS[priority] ?? `P${priority}`;

      console.log(`\n[Worker] Processing job ${job.id}`);
      console.log(`  Priority: ${label}`);
      console.log(`  Source: ${source}`);
      console.log(`  Repo: ${repo}`);
      console.log(`  Task: ${description.slice(0, 100)}${description.length > 100 ? "..." : ""}`);
      if (issueRef) console.log(`  Issue: ${issueRef}`);

      const result = await executeTask(repo, description, { issueRef });

      if (result.success) {
        console.log(`[Worker] Job ${job.id} completed. PR: ${result.prUrl ?? "none"}`);
      } else {
        console.log(`[Worker] Job ${job.id} failed: ${result.error}`);
        throw new Error(result.error ?? "Task execution failed");
      }

      return result;
    },
    {
      connection: REDIS_CONNECTION,
      concurrency: 1,
      stalledInterval: 30000,
      maxStalledCount: 1,
    }
  );

  worker.on("error", (err) => {
    console.error(`[Worker] Error: ${err.message}`);
  });

  return worker;
}

export async function stopWorker(worker: Worker): Promise<void> {
  await worker.close();
}
