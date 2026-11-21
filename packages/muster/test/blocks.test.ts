import { describe, expect, it } from 'vitest'
import { violation } from '../src/core/blocks.ts'
import { memoryBoard, reason } from './helpers.ts'

const SANDBOX = { type: 'object', required: ['id', 'state'], additionalProperties: false, properties: { id: { type: 'string', minLength: 3 }, state: { enum: ['running', 'stopped'] }, cpus: { type: 'integer', minimum: 1, maximum: 8 }, ports: { type: 'array', items: { type: 'integer' } } } }
const block = (data: unknown, name = 'sandbox@1') => 'status\n\n```json#' + name + '\n' + JSON.stringify(data) + '\n```'

describe('typed blocks', () => {
  it('a schedule is checked when it is made, like a post: what it sends later is data a program will read', async () => {
    const { team, time } = memoryBoard()
    await team.schemaAdd({ name: 'sandbox@1', schema: SANDBOX })
    expect(await reason(team.scheduleCreate({ channel: 'ops', text: block({ id: 'sbx_1', state: 'paused' }), at: '2026-01-01T00:00:01.000Z' }))).toBe('invalid_block')
    expect(await reason(team.scheduleCreate({ channel: 'ops', text: block({}, 'unknown@1'), at: '2026-01-01T00:00:01.000Z' }))).toBe('unknown_schema')
    await team.scheduleCreate({ channel: 'ops', text: block({ id: 'sbx_1', state: 'running' }), at: '2026-01-01T00:00:01.000Z' })
    time.advance(2000)
    await team.scheduleTick()
    expect((await team.readChannel({ channel: 'ops' })).threads.map((thread) => thread.message.blocks)).toEqual([[{ schema: 'sandbox@1', data: { id: 'sbx_1', state: 'running' } }]])
  })

  it('a message carries data as a block that names its schema, and a reader gets it parsed', async () => {
    const { team } = memoryBoard()
    await team.schemaAdd({ name: 'sandbox@1', schema: SANDBOX })
    const message = await team.post({ channel: 'ops', text: block({ id: 'sbx_1', state: 'running', cpus: 4, ports: [3000] }) })
    expect(message.blocks).toEqual([{ schema: 'sandbox@1', data: { id: 'sbx_1', state: 'running', cpus: 4, ports: [3000] } }])
    expect((await team.readThread({ id: message.id })).message.blocks[0]!.data).toMatchObject({ state: 'running' })
    expect((await team.post({ channel: 'ops', text: 'no data here' })).blocks).toEqual([])
  })

  it('refuses a block that does not follow its schema, and names the field', async () => {
    const { team } = memoryBoard()
    await team.schemaAdd({ name: 'sandbox@1', schema: SANDBOX })
    const post = (data: unknown) => team.post({ channel: 'ops', text: block(data) }).then(() => 'posted', (error: { reason: string; message: string }) => `${error.reason}: ${error.message}`)
    expect(await post({ id: 'sbx_1' })).toBe("invalid_block: The sandbox@1 block doesn't follow its schema: $.state is missing.")
    expect(await post({ id: 'sbx_1', state: 'paused' })).toMatch(/\$\.state isn't one of "running", "stopped"/)
    expect(await post({ id: 'x', state: 'running' })).toMatch(/\$\.id is shorter than 3/)
    expect(await post({ id: 'sbx_1', state: 'running', cpus: 9 })).toMatch(/\$\.cpus is over 8/)
    expect(await post({ id: 'sbx_1', state: 'running', ports: [80, 'x'] })).toMatch(/\$\.ports\[1\] is string, not integer/)
    expect(await post({ id: 'sbx_1', state: 'running', extra: 1 })).toMatch(/\$\.extra isn't in the schema/)
    expect(await post([1])).toMatch(/\$ is an array, not object/)
    expect((await team.readChannel({ channel: 'ops' })).threads).toEqual([])
  })

  it('refuses a block for a schema nobody registered, one that is not JSON, and the same on reply and edit', async () => {
    const { team } = memoryBoard()
    expect(await reason(team.post({ channel: 'ops', text: block({}, 'unknown@1') }))).toBe('unknown_schema')
    await team.schemaAdd({ name: 'sandbox@1', schema: SANDBOX })
    expect(await reason(team.post({ channel: 'ops', text: 'x\n```json#sandbox@1\n{ not json\n```' }))).toBe('invalid_block')
    const root = await team.post({ channel: 'ops', text: 'plain' })
    expect(await reason(team.reply({ to: root.id, text: block({ id: 'sbx_1' }) }))).toBe('invalid_block')
    expect(await reason(team.edit({ id: root.id, text: block({ id: 'sbx_1' }) }))).toBe('invalid_block')
    expect((await team.edit({ id: root.id, text: block({ id: 'sbx_1', state: 'stopped' }) })).blocks).toHaveLength(1)
  })

  it('a schema never changes: the same one again is fine, a different one needs a new version', async () => {
    const { team } = memoryBoard()
    expect(await team.schemaAdd({ name: 'sandbox@1', schema: SANDBOX })).toEqual({ name: 'sandbox@1', created: true })
    expect(await team.schemaAdd({ name: 'sandbox@1', schema: SANDBOX })).toEqual({ name: 'sandbox@1', created: false })
    expect(await reason(team.schemaAdd({ name: 'sandbox@1', schema: { type: 'object' } }))).toBe('schema_exists')
    await team.schemaAdd({ name: 'sandbox@2', schema: { type: 'object' } })
    expect((await team.schemaList()).schemas.map((schema) => schema.name)).toEqual(['sandbox@1', 'sandbox@2'])
    expect(await reason(team.schemaAdd({ name: 'Sandbox', schema: {} }))).toBe('invalid_schema')
    expect(await reason(team.schemaAdd({ name: 'sandbox@3', schema: [] as never }))).toBe('invalid_schema')
  })

  it('the validator on its own', () => {
    expect(violation({ type: 'number' }, 3)).toBeNull()
    expect(violation({ type: ['string', 'null'] }, null)).toBeNull()
    expect(violation({ type: 'string' }, 3)).toBe('$ is an integer, not string')
    expect(violation({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'boolean' } } } } }, { a: { b: 'no' } })).toBe('$.a.b is string, not boolean')
  })
})
