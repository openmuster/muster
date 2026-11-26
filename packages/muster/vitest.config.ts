import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A template's board module imports `muster` with no install of its own beside it, as `mu --module` loads
  // it: here that is this package's source, one copy with the tests'.
  resolve: { alias: { '@openmuster/muster': fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, pool: 'forks' },
})
