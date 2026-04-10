import type { ConnectionOptions } from "bullmq";

export const REDIS_CONNECTION: ConnectionOptions = {
  host: "127.0.0.1",
  port: 6379,
};

export const QUEUE_NAME = "yardmaster-tasks";
