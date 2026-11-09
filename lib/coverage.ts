/** Presentation only: preserve every distinct failure while collapsing repeated progress. */
export function normalizeCoverageGaps(values: readonly string[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    for (const part of value.split(/\r?\n/)) {
      const line = part.trim();
      if (!line) continue;
      result.add(line.replace(
        /: initial 90-day mail backfill incomplete\.?$/,
        ': 90-day email backfill is incomplete; Sync continues the saved cursor.',
      ));
    }
  }
  return [...result];
}
