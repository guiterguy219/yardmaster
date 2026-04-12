import {
  formatTaskQueued,
  formatTaskStarted,
  formatTaskCompleted,
  formatTaskFailed,
  formatPipelineStage,
} from "./format.js";
import { TELEGRAM_API } from "./constants.js";

/**
 * Send a message to a Telegram chat. Best-effort — never throws.
 * Uses HTML parse_mode for formatting.
 */
export async function notify(token: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn("Telegram sendMessage failed:", res.status, await res.text().catch(() => ""));
    }
  } catch {
    // Best effort — never throw
  }
}

function getTelegramCredentials(): { token: string; chatId: string } | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return undefined;
  return { token, chatId };
}

/**
 * Notify that a task has been queued. Best-effort — never throws.
 * Skips silently if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */
export function notifyTaskQueued(taskId: string, repo: string, description: string): void {
  const creds = getTelegramCredentials();
  if (!creds) return;
  void notify(creds.token, creds.chatId, formatTaskQueued(taskId, repo, description));
}

/**
 * Notify that a task has started. Best-effort — never throws.
 */
export function notifyTaskStarted(taskId: string, repo: string, description: string): void {
  const creds = getTelegramCredentials();
  if (!creds) return;
  void notify(creds.token, creds.chatId, formatTaskStarted(taskId, repo, description));
}

/**
 * Notify that a PR was created for a task. Best-effort — never throws.
 */
export function notifyTaskCompleted(taskId: string, repo: string, prUrl: string): void {
  const creds = getTelegramCredentials();
  if (!creds) return;
  void notify(creds.token, creds.chatId, formatTaskCompleted(taskId, repo, prUrl));
}

/**
 * Notify that a task failed. Best-effort — never throws.
 */
export function notifyTaskFailed(taskId: string, repo: string, error: string): void {
  const creds = getTelegramCredentials();
  if (!creds) return;
  void notify(creds.token, creds.chatId, formatTaskFailed(taskId, repo, error));
}

/**
 * Notify a pipeline stage transition (review complete, check passed, tests passed, etc.).
 * Best-effort — never throws.
 */
export function notifyPipelineStage(taskId: string, repo: string, message: string): void {
  const creds = getTelegramCredentials();
  if (!creds) return;
  void notify(creds.token, creds.chatId, formatPipelineStage(taskId, repo, message));
}
