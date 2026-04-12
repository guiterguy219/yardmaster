import { checkCapacity } from "../../capacity.js";

export function handleCapacity(): string {
  try {
    const cap = checkCapacity();
    const lines: string[] = [`<b>⚡ Capacity</b>`];
    lines.push(`Can proceed: ${cap.canProceed ? "✅ yes" : "🔴 NO"}`);
    lines.push(`Using overage: ${cap.isUsingOverage ? "⚠️ yes" : "no"}`);
    if (cap.resetsAt) {
      lines.push(`Resets at: <code>${cap.resetsAt.toISOString()}</code>`);
    }
    if (cap.reason) {
      lines.push(`Note: <i>${cap.reason}</i>`);
    }
    return lines.join("\n");
  } catch (err) {
    return `<b>⚡ Capacity</b>\n<i>Error: ${String(err)}</i>`;
  }
}
