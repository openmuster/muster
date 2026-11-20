// Checks a deployed docs site answers: a prerendered page, the search route (which runs in the
// Worker, so it is where a runtime fault shows), and a missing page.
//   node scripts/smoke-docs.mjs https://openmuster.ai
const base = process.argv[2]?.replace(/\/$/, '')
if (!base) throw new Error('use: smoke-docs.mjs <url>')
await new Promise((resolve) => setTimeout(resolve, Number(process.env.SMOKE_SETTLE_MS ?? 0)))

const checks = [
  ['/', 200, 'muster'],
  ['/docs/quickstart', 200, 'Quickstart'],
  ['/docs/concepts/tasks', 200, 'Tasks'],
  ['/api/search?query=lease', 200, 'lease'],
  ['/docs/no-such-page', 404, ''],
]
let failed = false
for (const [path, status, text] of checks) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' })
  const body = await response.text()
  const ok = response.status === status && body.toLowerCase().includes(String(text).toLowerCase())
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${response.status}  ${path}`)
  if (!ok) failed = true
}
if (failed) process.exit(1)
