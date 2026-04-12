import type { TaskRow } from "../db.js";
import type { PriorityLevel } from "../queue/constants.js";
import { PRIORITY_LABELS } from "../queue/constants.js";

export interface QueueEntry {
  id: string;
  repo: string;
  description: string;
  priority: PriorityLevel;
  queuedAt: number;
}

export interface WorkerStatusInfo {
  serviceActive: boolean;
  queueDepth: number;
  lastTask?: TaskRow;
}

const STATUS_ICON: Record<string, string> = {
  completed: "✅",
  done: "✅",
  failed: "❌",
  running: "🚀",
  interrupted: "⚠️",
  pending: "⏳",
  partial: "🔶",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function taskHeader(taskId: string, repo: string): string {
  return `<b>🤖 Yardmaster</b> · <code>${escapeHtml(taskId)}</code> · <i>${escapeHtml(repo)}</i>`;
}

export function formatTaskQueued(taskId: string, repo: string, description: string): string {
  return [
    taskHeader(taskId, repo),
    `⏳ <b>Queued</b>`,
    `<i>${escapeHtml(truncate(description, 120))}</i>`,
  ].join("\n");
}

export function formatTaskStarted(taskId: string, repo: string, description: string): string {
  return [
    taskHeader(taskId, repo),
    `🚀 <b>Started</b>`,
    `<i>${escapeHtml(truncate(description, 120))}</i>`,
  ].join("\n");
}

export function formatTaskCompleted(taskId: string, repo: string, prUrl: string): string {
  return [
    taskHeader(taskId, repo),
    `✅ <b>PR Created</b>`,
    `<a href="${escapeHtml(prUrl)}">${escapeHtml(prUrl)}</a>`,
  ].join("\n");
}

export function formatTaskFailed(taskId: string, repo: string, error: string): string {
  const truncatedError = truncate(error, 400);
  return [
    taskHeader(taskId, repo),
    `❌ <b>Failed</b>`,
    `<pre>${escapeHtml(truncatedError)}</pre>`,
  ].join("\n");
}

export function formatPipelineStage(taskId: string, repo: string, message: string): string {
  return [
    taskHeader(taskId, repo),
    `📊 ${escapeHtml(message)}`,
  ].join("\n");
}

export function formatQueueList(entries: QueueEntry[]): string {
  if (entries.length === 0) {
    return `<b>📋 Queue</b>\n<i>Empty — no pending tasks.</i>`;
  }

  const rows = entries.map((e, i) => {
    const label = PRIORITY_LABELS[e.priority] ?? String(e.priority);
    const desc = escapeHtml(truncate(e.description, 60));
    return `${i + 1}. [${escapeHtml(label)}] <code>${escapeHtml(e.id)}</code> <b>${escapeHtml(e.repo)}</b>\n   ${desc}`;
  });

  return [`<b>📋 Queue</b> (${entries.length})`, ...rows].join("\n");
}

export function formatWorkerStatus(info: WorkerStatusInfo): string {
  const lines: string[] = [`<b>⚙️ Worker Status</b>`];

  lines.push(`Service: ${info.serviceActive ? "✅ active" : "🔴 inactive"}`);
  lines.push(`Queue depth: <b>${info.queueDepth}</b>`);

  if (info.lastTask) {
    const t = info.lastTask;
    const icon = STATUS_ICON[t.status] ?? "❓";
    lines.push(
      `Last task: ${icon} <code>${escapeHtml(t.id)}</code> · ${escapeHtml(t.repo)} · <i>${escapeHtml(t.status)}</i>`
    );
  }

  return lines.join("\n");
}

export function formatRecentTasks(tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return `<b>📜 Recent Tasks</b>\n<i>No tasks found.</i>`;
  }

  const rows = tasks.map((t) => {
    const icon = STATUS_ICON[t.status] ?? "❓";
    const desc = escapeHtml(truncate(t.description, 50));
    return `${icon} <code>${escapeHtml(t.id)}</code> <b>${escapeHtml(t.repo)}</b>\n   <i>${desc}</i>`;
  });

  return [`<b>📜 Recent Tasks</b> (${tasks.length})`, ...rows].join("\n");
}
