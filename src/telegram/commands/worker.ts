import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getQueueContents } from "../../queue/task-queue.js";
import { getRecentTasks } from "../../db.js";
import { formatWorkerStatus } from "../format.js";

const execFileAsync = promisify(execFile);

export async function handleWorker(): Promise<string> {
  try {
    const serviceActive = await execFileAsync("systemctl", ["is-active", "yardmaster"], { timeout: 3000 })
      .then(({ stdout }) => stdout.trim() === "active")
      .catch(() => false);

    const jobs = await getQueueContents();
    const lastTasks = getRecentTasks(1);

    return formatWorkerStatus({
      serviceActive,
      queueDepth: jobs.length,
      lastTask: lastTasks[0],
    });
  } catch (err) {
    return `<b>⚙️ Worker Status</b>\n<i>Error: ${String(err)}</i>`;
  }
}
