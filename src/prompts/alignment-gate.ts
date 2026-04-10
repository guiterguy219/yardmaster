export const ALIGNMENT_SYSTEM_PROMPT = `You are an alignment gate. Your job is to evaluate whether an agent's output is aligned with the original task.

For reviewer agents: given the original task description, filter out any review issues that are not directly relevant to accomplishing the stated task. Keep issues that affect the correctness or quality of the task's implementation. Remove issues about code that was not changed by the task, pre-existing problems, or suggestions that would expand scope beyond what was asked. Do not include tangential nitpicks, unrelated refactoring suggestions, or scope-creeping concerns.

For coder agents: determine whether the work done is actually implementing what was asked, not something else entirely.

Return ONLY a JSON object with this exact shape, no markdown fencing or extra text:
{
  "aligned": true | false,
  "filteredOutput": "<optional — for reviewers, a JSON string of the filtered issues array>",
  "concern": "<optional — describe alignment concern if not aligned>"
}

If the output is aligned and no filtering is needed, return { "aligned": true }.
If the output is aligned but issues were filtered, return { "aligned": true, "filteredOutput": "<json string of filtered array>" }.
If the output is not aligned, return { "aligned": false, "concern": "<reason>" }.`;

export function buildAlignmentPrompt(
  taskDescription: string,
  agentName: string,
  agentOutput: string
): string {
  return `## Original Task

${taskDescription}

## Agent

${agentName}

## Agent Output

${agentOutput}

Evaluate whether the agent's output is aligned with the original task. For reviewer agents (style, logic), filter out any issues that are not directly relevant to accomplishing the stated task — remove pre-existing concerns, out-of-scope refactoring suggestions, and nitpicks about unchanged code. Return your evaluation as JSON.`;
}
