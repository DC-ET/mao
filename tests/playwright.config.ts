import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5200',
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'admin',
      testMatch: 'admin.spec.ts',
      use: { baseURL: 'http://localhost:5200' },
    },
    {
      name: 'desktop',
      testMatch: 'desktop.spec.ts',
      use: { baseURL: 'http://localhost:5201' },
    },
  ],
})
