import { getQueue } from "./task-queue.js";

export async function restorePriorityForStalledJobs(): Promise<{ restored: number }> {
  const queue = getQueue();
  const waiting = await queue.getJobs(["waiting"]);

  let restored = 0;
  for (const job of waiting) {
    const priority = job.opts?.priority;
    if (typeof priority !== "number" || priority === 0) continue;
    try {
      await job.changePriority({ priority });
      restored++;
    } catch {
      // Best effort — BullMQ may reject if the job state has changed.
    }
  }

  return { restored };
}
