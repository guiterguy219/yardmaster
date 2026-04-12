import { getRecentTasks } from "../../db.js";
import { formatRecentTasks } from "../format.js";

export function handleStatus(): string {
  try {
    const tasks = getRecentTasks(10);
    return formatRecentTasks(tasks);
  } catch (err) {
    return `<b>📜 Recent Tasks</b>\n<i>Error: ${String(err)}</i>`;
  }
}
