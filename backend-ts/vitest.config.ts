import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    // 2026-10-22 代码审查留档：`*.review-bugcheck.spec.ts` 断言的是「应有行为」，
    // 在对应缺陷修复前必然失败，用于证明缺陷真实存在；不并入默认 npm test，
    // 避免 CI 因未修复的缺陷恒红。修复对应缺陷后从本列表移除。
    // 单独运行：npm run test:bugcheck
    exclude: [...configDefaults.exclude, 'src/**/*.review-bugcheck.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/app.module.ts', 'src/create-app.ts', 'src/testing/**', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
      thresholds: {
        lines: 70,
      },
    },
  },
});
