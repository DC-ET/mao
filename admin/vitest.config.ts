import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// admin 单测基建：只覆盖纯逻辑（如 utils/embedContext），不引入组件测试框架。
// 依赖版本与 sdk/embed 对齐（vitest ^4.1.10 + happy-dom 20.14.0）。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@mao/contracts': path.resolve(__dirname, '../shared/contracts/src'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts'],
    // chunk-reload.spec.ts 用 node:test 编写（早于 vitest 基建，无脚本/CI 引用），排除以免 vitest 误抓
    exclude: ['**/node_modules/**', 'src/router/chunk-reload.spec.ts'],
  },
})
