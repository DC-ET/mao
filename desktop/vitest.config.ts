import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // 与 vite.config.ts 的 resolve.alias 同口径：测试里值导入 @mao/contracts 才能解析
  resolve: {
    alias: {
      '@mao/contracts': fileURLToPath(new URL('../shared/contracts/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
})
