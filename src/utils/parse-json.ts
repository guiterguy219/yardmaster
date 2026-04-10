/**
 * Parse JSON from agent output text.
 *
 * Handles:
 *   - Clean JSON strings
 *   - Markdown fenced blocks (```json ... ``` or ``` ... ```)
 *   - Plain text (non-JSON) → returns null
 *   - Empty strings → returns null
 */
export function parseAgentJson<T>(text: string): T | null {
  if (!text || !text.trim()) return null;

  // Strip markdown code fences (with or without language tag)
  const fenceMatch = text.match(/```(?:\w+)?\s*\n?([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text.trim();

  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
