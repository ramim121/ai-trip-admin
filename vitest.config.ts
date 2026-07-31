import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json, which the test runner
    // does not read on its own.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // API and server-side code — no DOM needed.
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    // e2e/ belongs to Playwright. Its specs import @playwright/test, which
    // throws if Vitest collects them.
    exclude: ['node_modules/**', '.next/**', 'e2e/**', 'src/generated/**'],
    passWithNoTests: true,
  },
})
