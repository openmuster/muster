import { defineConfig } from 'vitest/config'

// Tests that drive a real browser. They need the built page (`pnpm build`) and Chromium
// (`pnpm exec playwright install chromium`), so they are not part of `pnpm test`.
export default defineConfig({
  test: { include: ['browser/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000, pool: 'forks', fileParallelism: false },
})
