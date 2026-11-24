// What `wrangler types` would generate for `ctx.exports`: this Worker's own entrypoints, typed, so a
// gate that is renamed or removed fails `pnpm typecheck` instead of a run.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index.ts')
    durableNamespaces: 'Run'
  }
}
