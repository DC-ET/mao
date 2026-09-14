import { defineConfig } from 'vitest/config';

// 主进程也清掉：worker 继承 env。Ink 把 CI=true 当成非 TTY，live 区不会写到测试里的 stdout。
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    setupFiles: ['./test/setup-env.ts'],
  },
});

