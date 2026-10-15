import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/**/*.ts',
        'scripts/extract.mjs',
        'scripts/extract/**/*.mjs',
        'scripts/update.mjs',
        'scripts/update/**/*.mjs'
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90
      }
    },
    globals: true
  }
});
