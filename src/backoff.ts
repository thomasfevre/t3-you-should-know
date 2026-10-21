// Backoff after consecutive "learn: none" results, same curve as the Claude Code plugin:
// 0 skipped turns for the first 2 misses, then 1, 2, 4, 8, capped at 16.
export function skipTurns(consecutiveMisses: number): number {
  if (consecutiveMisses <= 2) return 0;
  return Math.min(16, 2 ** (consecutiveMisses - 3));
}
