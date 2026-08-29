import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 78,
        branches: 70,
        functions: 77,
        lines: 90,
      },
    },
  },
})
