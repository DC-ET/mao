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
    // 服务器已装系统 Chrome（/opt/google/chrome）。固定 chrome channel 复用系统内核，
    // 避免下载 640MB 自带 chromium；root 下必须 --no-sandbox 才能启动。
    channel: 'chrome',
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
  projects: [
    {
      name: 'admin',
      testMatch: /admin.*\.spec\.ts$/,
      use: { baseURL: 'http://localhost:5200' },
    },
    {
      name: 'desktop',
      testMatch: 'desktop.spec.ts',
      use: { baseURL: 'http://localhost:5201' },
    },
  ],
})
