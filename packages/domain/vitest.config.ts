import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 88,
        branches: 70,
        functions: 90,
        lines: 89,
      },
    },
  },
})
