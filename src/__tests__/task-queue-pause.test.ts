/**
 * Tests for the queue pause/resume functions added to src/queue/task-queue.ts.
 *
 * Covers:
 *  - pauseQueue() delegates to Queue.pause()
 *  - resumeQueue() delegates to Queue.resume()
 *  - isQueuePaused() delegates to Queue.isPaused() and returns its boolean result
 *
 * BullMQ and Redis are fully mocked so no Redis instance is needed.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock BullMQ before importing the module under test.
// The module-level `getQueue()` lazily constructs a Queue singleton, so we
// need to capture the mock instance to assert calls were made on it.
// ---------------------------------------------------------------------------

const mockPause = vi.fn().mockResolvedValue(undefined);
const mockResume = vi.fn().mockResolvedValue(undefined);
const mockIsPaused = vi.fn().mockResolvedValue(false);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("bullmq", () => {
  function MockQueue() {
    return {
      pause: mockPause,
      resume: mockResume,
      isPaused: mockIsPaused,
      close: mockClose,
      getJobs: vi.fn().mockResolvedValue([]),
    };
  }
  return { Queue: MockQueue };
});

// Import AFTER mocks are in place.
import { pauseQueue, resumeQueue, isQueuePaused, closeQueue } from "../queue/task-queue.js";

// ---------------------------------------------------------------------------
// Reset singleton state between tests so each test gets a fresh mock instance.
// closeQueue() nulls the internal `_queue` reference, which forces getQueue()
// to construct a new instance (using the mocked constructor) on next call.
// ---------------------------------------------------------------------------
beforeEach(async () => {
  await closeQueue();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe("pauseQueue", () => {
  it("calls Queue.pause() on the underlying BullMQ queue", async () => {
    await pauseQueue();
    expect(mockPause).toHaveBeenCalledOnce();
  });

  it("resolves without throwing", async () => {
    await expect(pauseQueue()).resolves.toBeUndefined();
  });

  it("propagates errors thrown by Queue.pause()", async () => {
    mockPause.mockRejectedValueOnce(new Error("Redis down"));
    await expect(pauseQueue()).rejects.toThrow("Redis down");
  });
});

// ---------------------------------------------------------------------------
describe("resumeQueue", () => {
  it("calls Queue.resume() on the underlying BullMQ queue", async () => {
    await resumeQueue();
    expect(mockResume).toHaveBeenCalledOnce();
  });

  it("resolves without throwing", async () => {
    await expect(resumeQueue()).resolves.toBeUndefined();
  });

  it("propagates errors thrown by Queue.resume()", async () => {
    mockResume.mockRejectedValueOnce(new Error("connection refused"));
    await expect(resumeQueue()).rejects.toThrow("connection refused");
  });
});

// ---------------------------------------------------------------------------
describe("isQueuePaused", () => {
  it("returns false when the queue is not paused", async () => {
    mockIsPaused.mockResolvedValueOnce(false);
    const result = await isQueuePaused();
    expect(result).toBe(false);
    expect(mockIsPaused).toHaveBeenCalledOnce();
  });

  it("returns true when the queue is paused", async () => {
    mockIsPaused.mockResolvedValueOnce(true);
    const result = await isQueuePaused();
    expect(result).toBe(true);
  });

  it("propagates errors thrown by Queue.isPaused()", async () => {
    mockIsPaused.mockRejectedValueOnce(new Error("Redis timeout"));
    await expect(isQueuePaused()).rejects.toThrow("Redis timeout");
  });
});

// ---------------------------------------------------------------------------
describe("pause / resume round-trip", () => {
  it("reflects the paused state correctly after pause then resume", async () => {
    // Simulate: not paused → paused → not paused
    mockIsPaused
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    expect(await isQueuePaused()).toBe(false);

    await pauseQueue();
    expect(await isQueuePaused()).toBe(true);

    await resumeQueue();
    expect(await isQueuePaused()).toBe(false);

    expect(mockPause).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledOnce();
  });
});
