import type { NextConfig } from 'next'

const config: NextConfig = {
  // muster opens a SQLite file with node:sqlite: it runs on the server, never in a bundle.
  serverExternalPackages: ['muster'],
  // The dev server is opened by address as often as by name; without this its scripts are refused there and no page comes alive.
  allowedDevOrigins: ['127.0.0.1'],
}
export default config
