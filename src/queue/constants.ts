// Priority levels: lower number = higher priority (P0 is immediate, P4 is background)
export const PRIORITY = {
  IMMEDIATE: 0,
  URGENT: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4,
} as const;

export type PriorityLevel = (typeof PRIORITY)[keyof typeof PRIORITY];

export const PRIORITY_LABELS: Record<PriorityLevel, string> = {
  [PRIORITY.IMMEDIATE]: "P0-immediate",
  [PRIORITY.URGENT]: "P1-urgent",
  [PRIORITY.HIGH]: "P2-high",
  [PRIORITY.NORMAL]: "P3-normal",
  [PRIORITY.LOW]: "P4-low",
};

// BullMQ priority 0 = no priority. Offset by 1 so P0 maps to BullMQ 1.
export function toBullMQPriority(p: PriorityLevel): number {
  return p + 1;
}

export function parsePriority(input: string): PriorityLevel {
  const lower = input.toLowerCase();
  if (lower === "immediate" || lower === "0") return PRIORITY.IMMEDIATE;
  if (lower === "urgent" || lower === "1") return PRIORITY.URGENT;
  if (lower === "high" || lower === "2") return PRIORITY.HIGH;
  if (lower === "normal" || lower === "3") return PRIORITY.NORMAL;
  if (lower === "low" || lower === "4") return PRIORITY.LOW;
  return PRIORITY.NORMAL;
}
