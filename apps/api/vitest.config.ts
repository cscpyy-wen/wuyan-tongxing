import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 76,
        branches: 65,
        functions: 87,
        lines: 83,
      },
    },
  },
})
