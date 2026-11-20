// The README and licence live at the repo root; a packed release carries its own copies.
import { copyFileSync } from 'node:fs'

for (const name of ['README.md', 'LICENSE']) copyFileSync(new URL(`../../../${name}`, import.meta.url), new URL(`../${name}`, import.meta.url))
