import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

// Isolate tests from the production queue so a running worker does not consume jobs
vi.mock("./connection.js", () => ({
  REDIS_CONNECTION: { host: "127.0.0.1", port: 6379 },
  QUEUE_NAME: "yardmaster-test",
}));

import { parsePriority, toBullMQPriority, PRIORITY, MS_PER_MINUTE, ONE_HOUR_MS } from "./constants.js";
import {
  enqueueTask,
  getQueueContents,
  removeJob,
  changePriority,
  closeQueue,
} from "./task-queue.js";

// ---------------------------------------------------------------------------
// Unit tests — no Redis required
// ---------------------------------------------------------------------------

describe("parsePriority", () => {
  it("parses string labels", () => {
    expect(parsePriority("immediate")).toBe(PRIORITY.IMMEDIATE);
    expect(parsePriority("urgent")).toBe(PRIORITY.URGENT);
    expect(parsePriority("high")).toBe(PRIORITY.HIGH);
    expect(parsePriority("normal")).toBe(PRIORITY.NORMAL);
    expect(parsePriority("low")).toBe(PRIORITY.LOW);
  });

  it("parses numeric strings", () => {
    expect(parsePriority("0")).toBe(PRIORITY.IMMEDIATE);
    expect(parsePriority("1")).toBe(PRIORITY.URGENT);
    expect(parsePriority("2")).toBe(PRIORITY.HIGH);
    expect(parsePriority("3")).toBe(PRIORITY.NORMAL);
    expect(parsePriority("4")).toBe(PRIORITY.LOW);
  });

  it("is case-insensitive", () => {
    expect(parsePriority("URGENT")).toBe(PRIORITY.URGENT);
    expect(parsePriority("High")).toBe(PRIORITY.HIGH);
  });

  it("defaults to NORMAL for unknown input", () => {
    expect(parsePriority("unknown")).toBe(PRIORITY.NORMAL);
    expect(parsePriority("")).toBe(PRIORITY.NORMAL);
  });
});

describe("time constants", () => {
  it("MS_PER_MINUTE equals 60 000 ms", () => {
    expect(MS_PER_MINUTE).toBe(60_000);
  });

  it("ONE_HOUR_MS equals 3 600 000 ms", () => {
    expect(ONE_HOUR_MS).toBe(3_600_000);
  });

  it("ONE_HOUR_MS equals 60 × MS_PER_MINUTE", () => {
    expect(ONE_HOUR_MS).toBe(60 * MS_PER_MINUTE);
  });
});

describe("toBullMQPriority", () => {
  it("offsets each priority level by 1", () => {
    expect(toBullMQPriority(PRIORITY.IMMEDIATE)).toBe(1);
    expect(toBullMQPriority(PRIORITY.URGENT)).toBe(2);
    expect(toBullMQPriority(PRIORITY.HIGH)).toBe(3);
    expect(toBullMQPriority(PRIORITY.NORMAL)).toBe(4);
    expect(toBullMQPriority(PRIORITY.LOW)).toBe(5);
  });

  it("preserves ordering (lower result = higher priority)", () => {
    expect(toBullMQPriority(PRIORITY.IMMEDIATE)).toBeLessThan(
      toBullMQPriority(PRIORITY.URGENT)
    );
    expect(toBullMQPriority(PRIORITY.URGENT)).toBeLessThan(
      toBullMQPriority(PRIORITY.LOW)
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require a running Redis on 127.0.0.1:6379
// ---------------------------------------------------------------------------

describe("task-queue integration", () => {
  const addedIds: string[] = [];

  beforeAll(async () => {
    // Verify Redis connectivity. If Redis is unavailable, this throws a clear
    // error rather than a cryptic timeout later.
    const id = await enqueueTask(
      "test-repo",
      "connectivity check",
      PRIORITY.LOW,
      "test"
    );
    addedIds.push(id);
  });

  afterEach(async () => {
    // Clean up every job added during a test
    for (const id of addedIds.splice(0)) {
      await removeJob(id).catch(() => {
        // job may already be removed (e.g. by changePriority)
      });
    }
  });

  afterAll(async () => {
    await closeQueue();
  });

  it("enqueues a task and returns a job id", async () => {
    const id = await enqueueTask(
      "my-repo",
      "do something",
      PRIORITY.NORMAL,
      "cli"
    );
    addedIds.push(id);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("getQueueContents returns the enqueued task", async () => {
    const id = await enqueueTask(
      "my-repo",
      "visible task",
      PRIORITY.HIGH,
      "cli",
      "issue-42"
    );
    addedIds.push(id);

    const contents = await getQueueContents();
    const found = contents.find((t) => t.id === id);
    expect(found).toBeDefined();
    expect(found!.repo).toBe("my-repo");
    expect(found!.description).toBe("visible task");
    expect(found!.priority).toBe(PRIORITY.HIGH);
    expect(found!.source).toBe("cli");
    expect(found!.issueRef).toBe("issue-42");
    expect(typeof found!.queuedAt).toBe("number");
  });

  it("sorts queue by priority then queuedAt", async () => {
    const urgentId = await enqueueTask("repo", "urgent task", PRIORITY.URGENT, "test");
    addedIds.push(urgentId);
    // Delay to ensure distinct queuedAt values even on loaded CI hosts
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const normalId = await enqueueTask("repo", "normal task", PRIORITY.NORMAL, "test");
    addedIds.push(normalId);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const lowId = await enqueueTask("repo", "low task", PRIORITY.LOW, "test");
    addedIds.push(lowId);

    const contents = await getQueueContents();
    // Filter to only the three jobs added in this test
    const ours = contents.filter((t) => [urgentId, normalId, lowId].includes(t.id));
    expect(ours).toHaveLength(3);
    expect(ours[0].id).toBe(urgentId);
    expect(ours[1].id).toBe(normalId);
    expect(ours[2].id).toBe(lowId);
  });

  it("removeJob removes the job from the queue", async () => {
    const id = await enqueueTask("repo", "to be removed", PRIORITY.LOW, "test");

    await removeJob(id);

    const contents = await getQueueContents();
    expect(contents.find((t) => t.id === id)).toBeUndefined();
    // id already removed — do not push to addedIds
  });

  it("changePriority re-queues the job with new priority at the front", async () => {
    const id = await enqueueTask(
      "repo",
      "reprioritize me",
      PRIORITY.LOW,
      "test"
    );
    addedIds.push(id);

    const newId = await changePriority(id, PRIORITY.URGENT);
    addedIds.push(newId);

    const contents = await getQueueContents();
    // changePriority removes old job and adds a new one; look up by the returned id.
    const found = contents.find((t) => t.id === newId);
    expect(found).toBeDefined();
    expect(found!.priority).toBe(PRIORITY.URGENT);
  });

  it("closeQueue can be called multiple times and queue reconnects", async () => {
    await closeQueue();
    // After close, enqueue should reconnect transparently
    const id = await enqueueTask("repo", "post-close task", PRIORITY.NORMAL, "test");
    addedIds.push(id);
    const contents = await getQueueContents();
    expect(contents.find((t) => t.id === id)).toBeDefined();
  });
});
