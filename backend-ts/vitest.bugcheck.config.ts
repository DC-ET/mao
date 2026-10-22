import { defineConfig } from 'vitest/config';

/**
 * 2026-10-22 代码审查留档专用配置：只跑 `*.review-bugcheck.spec.ts`。
 *
 * 这些用例断言「应有行为」，用于证明审查报告里的缺陷真实存在——
 * 在对应缺陷修复前它们必然失败（失败即证明）。因此它们被排除在默认
 * `npm test` 之外，避免 CI 因未修复的缺陷恒红。
 *
 * 运行：npm run test:bugcheck
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.review-bugcheck.spec.ts'],
    coverage: { enabled: false },
  },
});
