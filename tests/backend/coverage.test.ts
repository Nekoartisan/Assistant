import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
it('deduplicates routine progress across account and summary lines without hiding extraction errors', async () => {
  expect(existsSync('lib/coverage.ts'), 'Coverage normalization must exist').toBe(true);
  const coverage = await import('../../lib/coverage');
  expect(typeof coverage.normalizeCoverageGaps, 'Coverage normalization must be shared by API and UI').toBe('function');
  const result = coverage.normalizeCoverageGaps([
    'a@example.com: initial 90-day mail backfill incomplete.\na@example.com: calendar window scan incomplete.',
    'a@example.com: 90-day email backfill is incomplete; Sync continues the saved cursor.',
    'a@example.com: initial 90-day mail backfill incomplete.',
    'a@example.com: calendar window scan incomplete.',
    'a@example.com: email extraction paused; saved cursor will retry. Model output invalid.',
    'b@example.com: initial 90-day mail backfill incomplete.',
  ]);
  expect(result).toEqual([
    'a@example.com: 90-day email backfill is incomplete; Sync continues the saved cursor.',
    'a@example.com: calendar window scan incomplete.',
    'a@example.com: email extraction paused; saved cursor will retry. Model output invalid.',
    'b@example.com: 90-day email backfill is incomplete; Sync continues the saved cursor.',
  ]);
});
