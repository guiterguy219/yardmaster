/**
 * Result returned by an integration strategy module.
 *
 * Mirrors `IntegrationTestResult` from runner.ts but with an extra
 * `needsClarification` channel for the `ask-agent` strategy.
 */
export interface StrategyResult {
  ran: boolean;
  passed: boolean;
  output: string;
  attempts: number;
  testsWritten?: boolean;
  needsClarification?: boolean;
  clarificationQuestions?: string[];
}
