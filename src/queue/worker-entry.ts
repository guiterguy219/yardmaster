import { startWorker, stopWorker } from "./task-worker.js";

console.log("Yardmaster worker starting...");
const worker = startWorker();

const shutdown = async () => {
  console.log("\nShutting down worker...");
  await stopWorker(worker);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Worker running.");
