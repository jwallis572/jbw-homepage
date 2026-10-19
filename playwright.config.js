import { defineConfig, devices } from '@playwright/test';

// BASE_URL points the suite at a deployed site (e.g. a Vercel preview); otherwise serve locally.
const BASE_URL = process.env.BASE_URL;
const PORT = 4173;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL || `http://localhost:${PORT}`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    ...(bypass && { extraHTTPHeaders: { 'x-vercel-protection-bypass': bypass } }),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: BASE_URL ? undefined : {
    command: 'node scripts/serve.mjs',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
