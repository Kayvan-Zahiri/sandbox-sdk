import {timestampFromDate} from '@bufbuild/protobuf/wkt'
import {Code, ConnectError, createClient, createRouterTransport, type ServiceImpl} from '@connectrpc/connect'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {SandboxClient} from './client.js'
import {SandboxService} from './gen/depot/sandbox/v1/sandbox_pb.js'
import {Sandbox} from './sandbox.js'

const since = new Date('2026-10-15T00:00:00Z')
const until = new Date('2026-10-15T01:00:00Z')
const record = {
  message: 'héllo 🌍',
  source: 'stdout',
  timestamp: timestampFromDate(since),
  objectId: 'sb',
  contextIds: ['cmd'],
}
async function sandbox(overrides: Partial<ServiceImpl<typeof SandboxService>>) {
  const client: SandboxClient = {
    endpoint: 'http://test',
    rpc: createClient(
      SandboxService,
      createRouterTransport(({service}) =>
        service(SandboxService, {
          getSandbox: () => ({sandbox: {sandboxId: 'sb', organizationId: 'org'}}),
          ...overrides,
        }),
      ),
    ),
  }
  return Sandbox.get(client, 'sb')
}

test('logs.fetch forwards Modal filters and yields structured text records', async () => {
  const sb = await sandbox({
    async *fetchSandboxLogs(request) {
      assert.equal(request.sandbox?.selector.value, 'sb')
      assert.deepEqual(request.since, timestampFromDate(since))
      assert.deepEqual(request.until, timestampFromDate(until))
      assert.equal(request.source, 'stdout')
      assert.equal(request.searchText, 'héllo')
      yield record
    },
  })
  const entries = await Array.fromAsync(sb.logs.fetch({since, until, source: 'stdout', searchText: 'héllo'}))
  assert.deepEqual(entries, [{...record, timestamp: since}])
  assert.equal('complete' in entries[0]!, false)
  assert.equal('truncated' in entries[0]!, false)
})

test('logs.tail accepts omitted parameters and preserves empty and finite results', async () => {
  let calls = 0
  const sb = await sandbox({
    async *tailSandboxLogs(request) {
      calls++
      if (calls === 1) {
        assert.equal(request.entries, undefined)
        return
      }
      assert.equal(request.entries, 2)
      assert.equal(request.source, 'stderr')
      yield {...record, source: 'stderr'}
      yield {...record, source: 'stderr', message: 'second'}
    },
  })
  assert.deepEqual(await Array.fromAsync(sb.logs.tail()), [])
  const entries = await Array.fromAsync(sb.logs.tail({entries: 2, source: 'stderr'}))
  assert.deepEqual(
    entries.map((e) => e.message),
    ['héllo 🌍', 'second'],
  )
})

test('logs.fetch propagates errors after partial results', async () => {
  const sb = await sandbox({
    async *fetchSandboxLogs() {
      yield record
      throw new ConnectError('narrow range', Code.ResourceExhausted)
    },
  })
  const seen: string[] = []
  await assert.rejects(
    async () => {
      for await (const entry of sb.logs.fetch({since, until})) seen.push(entry.message)
    },
    (e: unknown) => e instanceof ConnectError && e.code === Code.ResourceExhausted,
  )
  assert.deepEqual(seen, [record.message])
})

test('logs iteration break closes and cancels the upstream stream', async () => {
  let closed = false
  let signal: AbortSignal | undefined
  const client = {
    endpoint: 'http://test',
    rpc: {
      getSandbox: async () => ({sandbox: {sandboxId: 'sb', organizationId: 'org'}}),
      tailSandboxLogs: (_request: unknown, options: {signal: AbortSignal}) => {
        signal = options.signal
        return (async function* () {
          try {
            yield record
            yield record
          } finally {
            closed = true
          }
        })()
      },
    },
  } as unknown as SandboxClient
  const sb = await Sandbox.get(client, 'sb')
  for await (const entry of sb.logs.tail()) {
    assert.equal(entry.message, record.message)
    break
  }
  assert.equal(closed, true)
  assert.equal(signal?.aborted, true)
})

test('logs.fetch validates dates before starting the request', async () => {
  const sb = await sandbox({
    fetchSandboxLogs() {
      throw new Error('must not call')
    },
  })
  for (const from of [new Date(NaN), until]) {
    await assert.rejects(Array.fromAsync(sb.logs.fetch({since: from, until})), TypeError)
  }
})
