import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/app.module.ts', 'src/create-app.ts', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
      thresholds: {
        lines: 70,
      },
    },
  },
});
