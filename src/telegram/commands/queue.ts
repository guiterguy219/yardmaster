import { getQueueContents } from "../../queue/task-queue.js";
import { formatQueueList } from "../format.js";

export async function handleQueue(): Promise<string> {
  try {
    const jobs = await getQueueContents();
    return formatQueueList(jobs);
  } catch (err) {
    return `<b>📋 Queue</b>\n<i>Error: ${String(err)}</i>`;
  }
}
