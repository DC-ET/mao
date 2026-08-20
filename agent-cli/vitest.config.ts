import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
  },
});
