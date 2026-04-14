export const ACTIONABILITY_SYSTEM_PROMPT = `You classify whether a GitHub issue is actionable as a coding task.

An issue is NOT actionable if:
- The title starts with "meta:", "tracker:", "epic:", or "roadmap:" (case-insensitive)
- The body contains phrases like "do not use as a task", "tracker", "discussion only", "roadmap"
- The body is primarily a checklist referencing other issues (e.g., "- [ ] refs #N", "- [ ] #N") with no concrete change instruction

An issue IS actionable if it describes a specific code change, bug fix, feature request, or technical task that can be implemented.

Return ONLY a JSON object with this exact shape, no markdown fencing or extra text:
{
  "actionable": true | false,
  "reason": "<brief explanation>"
}`;

export type ActionabilityResult = { actionable: boolean; reason: string };

export function buildActionabilityPrompt(title: string, body: string): string {
  // Truncate to keep prompt within token budget
  const truncatedBody = (body ?? "").slice(0, 1000);
  return `Evaluate whether this GitHub issue is actionable as a coding task.

## Title

${title}

## Body

${truncatedBody}

Classify this issue and return your evaluation as JSON.`;
}
