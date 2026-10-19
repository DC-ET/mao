import { defineConfig, devices } from '@playwright/test'

/**
 * 纯布局度量专用配置：不连后端 / 不跑 global-setup，只校验页面几何。
 * 适用于不依赖数据、只验证 CSS 结构的用例（如 workspace-file-dialog-height.spec.ts）。
 */
export default defineConfig({
  testDir: '.',
  testMatch: /workspace-file-dialog-(height|css)\.spec\.ts$/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
    viewport: { width: 1600, height: 900 },
    channel: 'chrome',
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
})
