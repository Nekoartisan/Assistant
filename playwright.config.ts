import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: { baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:3100', browserName: 'chromium' },
  reporter: 'list',
});
