import {
  mkdirSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCKS_DIR = fileURLToPath(new URL("../data/locks", import.meta.url));

/** Maximum age (ms) for a lock file before it is treated as stale, regardless of
 *  whether the PID is alive.  Guards against silent PID recycling by the OS. */
const LOCK_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Canonical exclusive pairs.  Each entry is symmetric: holding either name blocks
 *  the other.  Add new pairs here — reverse mappings are derived automatically. */
const EXCLUSIVE_PAIRS: [string, string][] = [["playwright", "emulator"]];

/** Derived lookup: name → names that are mutually exclusive with it. */
const MUTEX_PAIRS: Record<string, string[]> = {};
for (const [a, b] of EXCLUSIVE_PAIRS) {
  (MUTEX_PAIRS[a] ??= []).push(b);
  (MUTEX_PAIRS[b] ??= []).push(a);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LockData {
  pid: number;
  ts: number;
}

function readLockData(lockPath: string): LockData | null {
  try {
    const parts = readFileSync(lockPath, "utf-8").trim().split(":");
    const pid = parseInt(parts[0], 10);
    const ts = parseInt(parts[1], 10);
    if (isNaN(pid) || isNaN(ts)) return null;
    return { pid, ts };
  } catch {
    return null;
  }
}

function isLockStale(data: LockData): boolean {
  if (!isPidAlive(data.pid)) return true;
  // PID appears alive — guard against silent PID recycling by the OS
  return Date.now() - data.ts > LOCK_TTL_MS;
}

function tryCleanStale(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best effort
  }
}

export interface LockResult {
  /** Whether this process successfully acquired the lock. */
  acquired: boolean;
  /** Human-readable reason when `acquired` is false. */
  reason?: string;
}

/**
 * Attempt to acquire a named lock for the current process.
 *
 * Creates `data/locks/{name}.lock` containing `PID:timestamp`.  As a
 * side-effect, stale locks (dead PID or older than 1 hour) are cleaned up
 * before acquisition is attempted — the TTL acts as a secondary guard
 * against silent PID recycling.
 *
 * Mutually exclusive names (e.g. `"playwright"` and `"emulator"`) are
 * enforced: if any exclusive peer holds a live lock, acquisition fails.
 *
 * The create step uses `O_CREAT | O_EXCL` (via flag `"wx"`) so two
 * concurrent callers cannot both believe they acquired the same lock.
 *
 * @param name  Logical lock name (e.g. `"playwright"`, `"emulator"`).
 * @returns     `{ acquired: true }` on success, or `{ acquired: false, reason }`.
 */
export function acquireLock(name: string): LockResult {
  mkdirSync(LOCKS_DIR, { recursive: true });

  const lockPath = join(LOCKS_DIR, `${name}.lock`);
  const content = `${process.pid}:${Date.now()}`;

  // Atomically create our own lock first (O_CREAT|O_EXCL via "wx").
  // Acquiring our lock before checking peers ensures that any racing peer
  // will see our lock already present and refuse, avoiding the TOCTOU window
  // that exists when peers are checked before self-lock acquisition.
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;

    // File exists — check if it is stale
    const data = readLockData(lockPath);
    if (data !== null && !isLockStale(data)) {
      return {
        acquired: false,
        reason: `Lock "${name}" is already held by PID ${data.pid}`,
      };
    }
    // Stale — clean up and retry once
    tryCleanStale(lockPath);
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      return {
        acquired: false,
        reason: `Lock "${name}" could not be acquired after stale cleanup`,
      };
    }
  }

  // Write PID:timestamp — clean up the lock file immediately if the write
  // fails so the creating process does not leave an orphaned lock on disk.
  let writeOk = false;
  try {
    writeSync(fd, content);
    writeOk = true;
  } finally {
    closeSync(fd);
    if (!writeOk) {
      tryCleanStale(lockPath);
    }
  }

  // Now that our lock is committed, check exclusive peers.  Any peer that
  // raced us will either find our lock already present (and refuse) or have
  // already written its own lock before we check — both outcomes are safe.
  for (const peer of MUTEX_PAIRS[name] ?? []) {
    const peerPath = join(LOCKS_DIR, `${peer}.lock`);
    const data = readLockData(peerPath);
    if (data !== null && !isLockStale(data)) {
      // Roll back our own lock — we cannot hold it alongside a live peer.
      tryCleanStale(lockPath);
      return {
        acquired: false,
        reason: `Exclusive peer "${peer}" is held by PID ${data.pid}`,
      };
    }
    // Peer lock is stale — clean it up as a courtesy.
    if (data !== null) tryCleanStale(peerPath);
  }

  return { acquired: true };
}

/**
 * Release a named lock held by the current process.
 *
 * Only deletes the lock file when the PID recorded in it matches the current
 * process.  This prevents a process from accidentally releasing a lock it no
 * longer owns (e.g. after crashing and restarting while another process has
 * since acquired the lock).
 *
 * @param name  Logical lock name to release.
 */
export function releaseLock(name: string): void {
  const lockPath = join(LOCKS_DIR, `${name}.lock`);
  const data = readLockData(lockPath);
  if (data?.pid !== process.pid) return; // not our lock — do not touch it
  try {
    unlinkSync(lockPath);
  } catch {
    // best effort
  }
}

export interface MemoryCheck {
  /** True when free memory meets or exceeds the requested threshold. */
  available: boolean;
  /**
   * Free memory in MiB as reported by `/proc/meminfo` (`MemAvailable`).
   * `-1` when the value could not be determined (non-Linux host).
   */
  freeMb: number;
}

const DEFAULT_THRESHOLD_MB = 1024;

/**
 * Check whether enough memory is available to safely start a heavy process.
 *
 * Reads `/proc/meminfo` (Linux only).  On any other OS — or if the file
 * cannot be read for any reason — returns `{ available: true, freeMb: -1 }`
 * (fail-open) so that non-Linux environments are never permanently blocked.
 *
 * @param thresholdMb  Required free MiB (default: 1 GiB).
 * @returns            `{ available, freeMb }`.
 */
export function checkMemoryAvailable(
  thresholdMb = DEFAULT_THRESHOLD_MB
): MemoryCheck {
  try {
    const raw = readFileSync("/proc/meminfo", "utf-8");
    const match = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!match) {
      // MemAvailable line absent (unusual kernel/container) — fail-open so the
      // caller is not silently blocked by an indeterminate value.
      return { available: true, freeMb: -1 };
    }
    const freeMb = Math.floor(parseInt(match[1], 10) / 1024);
    return { available: freeMb >= thresholdMb, freeMb };
  } catch {
    // /proc/meminfo is Linux-only; fail-open on other platforms
    return { available: true, freeMb: -1 };
  }
}
