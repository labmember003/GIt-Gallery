import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './web-tests',
  fullyParallel: true,
  workers: 3,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8092',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node web-tests/server.mjs',
    url: 'http://127.0.0.1:8092',
    reuseExistingServer: false,
  },
});
