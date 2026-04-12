import { loadTelegramConfig } from "../config.js";
import { notify } from "./notify.js";
import { handleStatus } from "./commands/status.js";
import { handleQueue } from "./commands/queue.js";
import { handleWorker } from "./commands/worker.js";
import { handleCapacity } from "./commands/capacity.js";
import { TELEGRAM_API } from "./constants.js";

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function getUpdates(
  token: string,
  offset: number,
  timeout: number,
  abortSignal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const url = `${TELEGRAM_API}/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%5D`;
  const timeoutSignal = AbortSignal.timeout((timeout + 5) * 1000);
  const signal = AbortSignal.any([abortSignal, timeoutSignal]);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`getUpdates failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
  if (!data.ok) throw new Error("getUpdates returned ok=false");
  return data.result;
}

export async function startBot(): Promise<void> {
  const cfg = loadTelegramConfig();
  if (!cfg) {
    console.error("Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
    process.exit(1);
  }

  const { botToken: token, chatId } = cfg;

  console.log("Yardmaster Telegram bot starting...");

  let offset = 0;
  let running = true;
  const controller = new AbortController();

  const shutdown = () => {
    running = false;
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Bot running. Press Ctrl+C to stop.\n");

  while (running) {
    let updates: TelegramUpdate[];
    try {
      updates = await getUpdates(token, offset, 30, controller.signal);
    } catch {
      if (!running) break;
      // Network or API error — back off and retry
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;

      const msg = update.message;
      if (!msg?.text) continue;

      // Auth guard: only respond to the configured chat ID
      if (String(msg.chat.id) !== chatId) continue;

      // Strip optional /command@BotUsername suffix
      const command = msg.text.trim().split(/\s+/)[0].split("@")[0];

      let reply: string;
      try {
        if (command === "/start") {
          reply = [
            "<b>🤖 Yardmaster Bot</b>",
            "",
            "Available commands:",
            "/status — recent task history",
            "/queue — pending tasks in queue",
            "/worker — worker &amp; service status",
            "/capacity — rate-limit capacity",
          ].join("\n");
        } else if (command === "/status") {
          reply = handleStatus();
        } else if (command === "/queue") {
          reply = await handleQueue();
        } else if (command === "/worker") {
          reply = await handleWorker();
        } else if (command === "/capacity") {
          reply = handleCapacity();
        } else {
          continue;
        }
      } catch (err) {
        console.error("Command handler error:", err);
        await notify(token, chatId, "⚠️ Command failed — please try again.");
        continue;
      }

      await notify(token, chatId, reply);
    }
  }
}
