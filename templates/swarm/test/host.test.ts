import { describe, expect, it } from 'vitest'
import { answersFor } from '../lib/host.ts'

describe('the names this page answers for', () => {
  it('answers for this machine, and for no other name unless it is listed', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', 'LOCALHOST', '[::1]:3000']) expect(answersFor(host)).toBe(true)
    // A page on another site can point a name of its own at 127.0.0.1 and have a browser send requests here under it.
    for (const host of ['evil.example', 'evil.example:3000', '127.0.0.1.evil.example', 'localhost.evil.example:3000', '', null]) expect(answersFor(host)).toBe(false)
    expect(answersFor('board.internal', 'board.internal, other.internal')).toBe(true)
    expect(answersFor('board.internal:3000', 'board.internal')).toBe(true)
    expect(answersFor('evil.example', 'board.internal')).toBe(false)
  })
})
