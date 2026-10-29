import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

/**
 * 第 1 轮审查复现用配置：拷到 desktop/.tmp-test/ 后使用（见同目录 README.md）。
 * 只跑 .tmp-test 下的 jsdom 用例，不改仓库既有 vitest.config.ts。
 */
export default defineConfig({
  root: path.resolve(__dirname, '..'),
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['.tmp-test/**/*.test.ts'],
    globals: true,
  },
})
