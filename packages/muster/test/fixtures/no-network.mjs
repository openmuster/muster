// Loaded before the CLI in a test: writes down every attempt to open a connection or look up a name.
import { appendFileSync } from 'node:fs'
import dns from 'node:dns'
import net from 'node:net'

const log = process.env.MUSTER_TEST_NETLOG
const note = (what) => log && appendFileSync(log, `${what}\n`)
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = args[0]
  // A pipe to another local process (a path) is not the network.
  if (!(first && typeof first === 'object' && 'path' in first) && typeof first !== 'string') note(`connect ${JSON.stringify(first)}`)
  return connect.apply(this, args)
}
const lookup = dns.lookup
dns.lookup = function (host, ...rest) {
  note(`lookup ${host}`)
  return lookup.call(this, host, ...rest)
}
