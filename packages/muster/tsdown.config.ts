import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', cli: 'src/cli/bin.ts' },
    format: 'esm',
    dts: true,
    clean: true,
    platform: 'node',
  },
  {
    // The inspector's page: React and everything it needs in one file the local server hands out.
    entry: { app: 'src/inspect/app/main.tsx' },
    outDir: 'dist/inspect',
    format: 'esm',
    platform: 'browser',
    dts: false,
    clean: false,
    minify: true,
    noExternal: [/.*/],
    define: { 'process.env.NODE_ENV': '"production"' },
  },
])
