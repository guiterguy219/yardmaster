export const ACTIONABILITY_CLASSIFIER_SYSTEM_PROMPT = `You are an issue actionability classifier. Your job is to determine whether a GitHub issue describes a concrete, actionable coding task or is a non-actionable meta/tracking/discussion issue.

Return ONLY valid JSON in this exact format:
{ "actionable": boolean, "reason": string }

An issue is NON-ACTIONABLE if any of these apply:
- Title starts with "meta:", "tracker:", "epic:", or "roadmap:" (case-insensitive)
- Body contains explicit opt-out language like "do not use as a task", "tracker", "discussion only"
- Body is a pure checklist of references (e.g. "refs #N", "see #M") with no concrete change instruction
- The issue is purely organizational, a milestone tracker, or a discussion thread with no single deliverable

An issue IS ACTIONABLE if it describes a specific change to make: a bug to fix, a feature to add, a refactor to perform, etc.

When in doubt, classify as actionable.`;

export function buildActionabilityPrompt(
  title: string,
  body: string,
  labels: string[]
): string {
  const truncatedBody = body.slice(0, 500);
  const labelList = labels.length > 0 ? labels.join(", ") : "none";

  return `Classify this GitHub issue as actionable or non-actionable.

Title: ${title}
Labels: ${labelList}
Body: ${truncatedBody}

Return ONLY JSON: { "actionable": boolean, "reason": string }`;
}
