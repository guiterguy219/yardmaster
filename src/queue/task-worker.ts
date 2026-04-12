import { Worker, DelayedError, type Job } from "bullmq";
import { REDIS_CONNECTION, QUEUE_NAME } from "./connection.js";
import {
  PRIORITY,
  PRIORITY_LABELS,
  MS_PER_MINUTE,
  ONE_HOUR_MS,
  type PriorityLevel,
} from "./constants.js";
import { executeTask } from "../task-runner.js";
import { checkCapacity } from "../capacity.js";
import { loadConfig, getRepo } from "../config.js";

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
    async (job: Job<TaskJobData>, token?: string) => {
      const { repo, description, priority, source, issueRef } = job.data;
      const label = PRIORITY_LABELS[priority] ?? `P${priority}`;

      console.log(`\n[Worker] Processing job ${job.id}`);
      console.log(`  Priority: ${label}`);
      console.log(`  Source: ${source}`);
      console.log(`  Repo: ${repo}`);
      console.log(`  Task: ${description.slice(0, 100)}${description.length > 100 ? "..." : ""}`);
      if (issueRef) console.log(`  Issue: ${issueRef}`);

      // Capacity gate: defer the job back to the queue if overage policy applies.
      // P0 (immediate) jobs always bypass the capacity check.
      if (priority !== PRIORITY.IMMEDIATE) {
        let overagePolicy;
        try {
          const config = loadConfig();
          const repoConfig = getRepo(config, repo);
          overagePolicy = repoConfig.overagePolicy;
        } catch (err) {
          console.log(
            `  Capacity check skipped: could not resolve repo config (${(err as Error).message})`
          );
        }
        const status = checkCapacity(priority, overagePolicy);
        if (!status.canProceed) {
          if (status.reason === "overage-deferred") {
            const resumeAt = status.resetsAt?.getTime() ?? Date.now() + ONE_HOUR_MS;
            const delay = Math.max(0, resumeAt - Date.now());
            console.log(
              `  Deferred: Job ${job.id} (overage, ${label}) — re-queued in ${Math.round(delay / MS_PER_MINUTE)}min`
            );
            await job.moveToDelayed(Date.now() + delay, token);
            throw new DelayedError();
          }
          throw new Error(status.reason ?? "Capacity check failed");
        }
      }

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
