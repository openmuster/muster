import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dropClaim, heldClaim, keepClaim } from '../src/cli/claims.ts'
import { tempDir } from './helpers.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

describe('kept claims', () => {
  let before: string | undefined
  let config: string
  beforeEach(() => {
    before = process.env.MUSTER_CONFIG
    config = tempDir()
    process.env.MUSTER_CONFIG = config
  })
  afterEach(() => {
    if (before === undefined) delete process.env.MUSTER_CONFIG
    else process.env.MUSTER_CONFIG = before
  })

  it('are kept per principal: the same board and profile name under another principal finds nothing', () => {
    const ada = { where: 'http://127.0.0.1:4100/api/board', principal: 'local:user:ada', profile: 'fixer' }
    keepClaim(ada, 12, { token: 'secret', until: new Date(Date.now() + 60_000).toISOString() })
    expect(heldClaim(ada, 12)).toBe('secret')
    expect(heldClaim({ ...ada, principal: 'local:user:eve' }, 12)).toBeUndefined()
    dropClaim(ada, 12)
    expect(heldClaim(ada, 12)).toBeUndefined()
  })

  it('one kept by an older muster for a board on a file is still found, and dropped with it', () => {
    const ada = { where: '/home/ada/.muster/main.db', principal: 'local:user:ada', profile: null }
    const old = join(config, 'claims', hash(ada.where))
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, '12-_.json'), JSON.stringify({ token: 'from-before', until: new Date().toISOString() }))
    expect(heldClaim(ada, 12)).toBe('from-before')
    dropClaim(ada, 12)
    expect(heldClaim(ada, 12)).toBeUndefined()
  })

  it('an old one is never read for a served board, where several callers share the process', () => {
    const ada = { where: 'http://127.0.0.1:4100/api/board', principal: 'local:user:eve', profile: 'fixer' }
    const old = join(config, 'claims', hash(ada.where))
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, '12-fixer.json'), JSON.stringify({ token: 'someone-elses', until: new Date().toISOString() }))
    expect(heldClaim(ada, 12)).toBeUndefined()
  })
})
