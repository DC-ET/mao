import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    // 2026-10-22 代码审查留档：`*.review-bugcheck.test.ts` 断言的是「应有行为」，
    // 在对应缺陷修复前必然失败，用于证明缺陷真实存在；不并入默认 test:unit，
    // 避免 CI 因未修复的缺陷恒红。修复对应缺陷后从本列表移除。
    // 单独运行：npm run test:bugcheck
    exclude: [...configDefaults.exclude, 'src/**/*.review-bugcheck.test.ts'],
  },
})
