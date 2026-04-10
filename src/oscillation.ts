import { getReviewHistory } from "./diff-ledger.js";

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[m][n];
}

export function detectOscillation(
  taskId: string,
  currentDiff: string
): { detected: boolean; reason?: string } {
  const history = getReviewHistory(taskId);

  // Get distinct rounds, sorted ascending
  const rounds = [...new Set(history.map((r) => r.round))].sort((a, b) => a - b);

  if (rounds.length < 2) {
    return { detected: false };
  }

  // Compare current diff against the diff from 2 rounds ago (second-to-last distinct round)
  const targetRound = rounds[rounds.length - 2];
  const targetEntry = history.find((r) => r.round === targetRound);

  if (!targetEntry) {
    return { detected: false };
  }

  const pastDiff = targetEntry.diff_text;
  const maxLength = Math.max(currentDiff.length, pastDiff.length);

  if (maxLength === 0) {
    return { detected: false };
  }

  const distance = levenshtein(currentDiff, pastDiff);
  const similarity = 1 - distance / maxLength;

  if (similarity > 0.85) {
    return {
      detected: true,
      reason: `Diff is ${(similarity * 100).toFixed(1)}% similar to round ${targetRound} (oscillation detected)`,
    };
  }

  return { detected: false };
}
