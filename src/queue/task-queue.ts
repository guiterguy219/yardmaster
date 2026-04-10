import { Queue } from "bullmq";
import { REDIS_CONNECTION, QUEUE_NAME } from "./connection.js";
import { toBullMQPriority, PRIORITY_LABELS, type PriorityLevel } from "./constants.js";

export interface QueuedTask {
  id: string;
  repo: string;
  description: string;
  priority: PriorityLevel;
  source: string;
  issueRef?: string;
  queuedAt: number;
}

interface TaskJobData {
  repo: string;
  description: string;
  priority: PriorityLevel;
  source: string;
  issueRef?: string;
  queuedAt: number;
}

let _queue: Queue | null = null;

export function getQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, { connection: REDIS_CONNECTION });
  }
  return _queue;
}

export async function enqueueTask(
  repo: string,
  description: string,
  priority: PriorityLevel,
  source: string,
  issueRef?: string
): Promise<string> {
  const queue = getQueue();
  const data: TaskJobData = {
    repo,
    description,
    priority,
    source,
    issueRef,
    queuedAt: Date.now(),
  };

  const job = await queue.add("task", data, {
    priority: toBullMQPriority(priority),
  });

  return job.id!;
}

export async function getQueueContents(): Promise<QueuedTask[]> {
  const queue = getQueue();
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"]);

  return jobs
    .map((job) => {
      const data = job.data as TaskJobData;
      return {
        id: job.id!,
        repo: data.repo,
        description: data.description,
        priority: data.priority,
        source: data.source,
        issueRef: data.issueRef,
        queuedAt: data.queuedAt,
      };
    })
    .sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
}

export async function removeJob(jobId: string): Promise<void> {
  const queue = getQueue();
  const job = await queue.getJob(jobId);
  if (job) await job.remove();
}

export async function changePriority(
  jobId: string,
  newPriority: PriorityLevel
): Promise<string> {
  const queue = getQueue();
  const job = await queue.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const data = job.data as TaskJobData;
  await job.remove();
  const newJob = await queue.add("task", { ...data, priority: newPriority }, {
    priority: toBullMQPriority(newPriority),
  });
  return newJob.id!;
}

export async function closeQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}
