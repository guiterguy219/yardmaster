export const HISTORY_INGESTOR_SYSTEM_PROMPT = `You are a code analysis assistant. Analyze task history and return JSON insights.`;

export interface HistoryInsight {
  key: string;
  content: string;
  agentRoles: string[] | null;
}

export interface HistoryIngestorOutput {
  insights: HistoryInsight[];
}

export function buildHistoryIngestorPrompt(summary: string): string {
  return `Given the following summary of completed coding tasks and their review outcomes for a repository, identify recurring patterns and insights that would help future agents.

Focus on:
- Common types of issues raised by reviewers (what mistakes keep happening?)
- Patterns in convergence speed (what makes tasks converge faster or slower?)
- Any repo-specific conventions that reviewers consistently enforce

Return ONLY valid JSON:
{
  "insights": [
    {
      "key": "history:<descriptive-name>",
      "content": "<the insight>",
      "agentRoles": ["coder"] or ["style-reviewer"] or null
    }
  ]
}

Task history:
${summary}`;
}
