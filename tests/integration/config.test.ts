import { expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('private assistant sends frame and content-type protection headers', async () => {
  const file = resolve('next.config.ts');
  expect(existsSync(file), 'Next security configuration must exist').toBe(true);
  const { default: config } = await import('../../next.config');
  const routes = await config.headers!();
  const all = routes.find(r => r.source === '/:path*');
  expect(all?.headers).toEqual(expect.arrayContaining([
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
  ]));
  const api = routes.find(r => r.source === '/api/:path*');
  expect(api?.headers).toContainEqual({key: 'Cache-Control', value: 'private, no-store, max-age=0'});
});
