import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../playwright-report' }],
  ],
  outputDir: '../../test-results',
  use: {
    channel: 'chromium',
    baseURL: process.env.ADMIN_E2E_URL ?? 'http://127.0.0.1:3300',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
});
