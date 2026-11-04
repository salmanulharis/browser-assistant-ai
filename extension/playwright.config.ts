import { defineConfig } from '@playwright/test';

/** E2E: loads the built extension (.output/chrome-mv3) into Chromium and talks to a real backend. */
export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
