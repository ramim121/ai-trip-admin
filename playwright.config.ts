import { defineConfig, devices } from '@playwright/test'

// Admin runs on 3001 so it does not collide with the public web app on 3000.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // A stray `test.only` should fail CI rather than silently skip the suite.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
