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

test('retained logs use the sandbox.logs API', async () => {
  const sb = await sandbox({})
  assert.equal('readLogs' in sb, false)
  assert.equal('streamLogs' in sb, false)
  assert.equal(typeof sb.logs.fetch, 'function')
  assert.equal(typeof sb.logs.tail, 'function')
  assert.equal(typeof sb.logs.stream, 'function')
})

test('logs.fetch forwards query filters and yields structured text records', async () => {
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

test('logs preserves and filters unknown customer output', async () => {
  const sb = await sandbox({
    async *fetchSandboxLogs(request) {
      assert.equal(request.source, 'unknown')
      yield {...record, source: 'unknown'}
    },
    async *tailSandboxLogs(request) {
      assert.equal(request.source, 'unknown')
      yield {...record, source: 'unknown'}
    },
  })
  const fetched = await Array.fromAsync(sb.logs.fetch({since, until, source: 'unknown'}))
  const latest = await Array.fromAsync(sb.logs.tail({source: 'unknown'}))
  assert.equal(fetched[0]?.source, 'unknown')
  assert.equal(latest[0]?.source, 'unknown')
})

test('logs.stream defaults to no replay and maps all retained or timestamp replay', async () => {
  for (const replay of [undefined, 'none', 'all', since] as const) {
    const sb = await sandbox({
      async *streamSandboxLogs(request) {
        assert.equal(request.sandbox?.selector.value, 'sb')
        assert.equal(request.replay, replay instanceof Date ? 'since' : (replay ?? 'none'))
        assert.deepEqual(request.since, replay instanceof Date ? timestampFromDate(replay) : undefined)
        assert.equal(request.source, 'stdout')
        yield record
      },
    })
    assert.deepEqual(await Array.fromAsync(sb.logs.stream({replay, source: 'stdout'})), [{...record, timestamp: since}])
  }
})
test('logs.stream validates invalid replay dates before opening a request', async () => {
  const sb = await sandbox({
    streamSandboxLogs() {
      throw new Error('must not call')
    },
  })
  await assert.rejects(Array.fromAsync(sb.logs.stream({replay: new Date(NaN)})), TypeError)
})
test('logs.stream propagates failures after delivering output', async () => {
  const sb = await sandbox({
    async *streamSandboxLogs() {
      yield record
      throw new ConnectError('reset', Code.Unavailable)
    },
  })
  const seen: string[] = []
  await assert.rejects(
    async () => {
      for await (const entry of sb.logs.stream()) seen.push(entry.message)
    },
    (error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable,
  )
  assert.deepEqual(seen, [record.message])
})
test('logs.stream supports cancellation while waiting and cancels on break', async () => {
  let signal: AbortSignal | undefined
  let closed = false
  let waiting: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    waiting = resolve
  })
  const client = {
    endpoint: 'http://test',
    rpc: {
      getSandbox: async () => ({sandbox: {sandboxId: 'sb', organizationId: 'org'}}),
      streamSandboxLogs: (_request: unknown, options: {signal: AbortSignal}) => {
        signal = options.signal
        return (async function* () {
          try {
            yield record
            await new Promise<never>((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(new ConnectError('cancelled', Code.Canceled)), {
                once: true,
              })
              waiting?.()
            })
          } finally {
            closed = true
          }
        })()
      },
    },
  } as unknown as SandboxClient
  const sb = await Sandbox.get(client, 'sb')
  for await (const entry of sb.logs.stream()) {
    assert.equal(entry.message, record.message)
    break
  }
  assert.equal(signal?.aborted, true)
  assert.equal(closed, true)
  closed = false
  const controller = new AbortController()
  const iterator = sb.logs.stream({signal: controller.signal})[Symbol.asyncIterator]()
  await iterator.next()
  const pending = iterator.next()
  await ready
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof ConnectError && error.code === Code.Canceled)
  assert.equal(closed, true)
})

for (const [seconds, nanos, iso] of [
  [1792136178n, 984737268, '2026-10-16T07:36:18.984Z'],
  [1792136178n, 999999999, '2026-10-16T07:36:18.999Z'],
  [1792136178n, 984000000, '2026-10-16T07:36:18.984Z'],
  [-1n, 999999999, '1969-12-31T23:59:59.999Z'],
] as const) {
  test(`log timestamp ${seconds}:${nanos} preserves its inclusive replay boundary`, async () => {
    const captured = {...record, timestamp: {seconds, nanos}}
    const sb = await sandbox({
      async *fetchSandboxLogs() {
        yield captured
      },
      async *tailSandboxLogs() {
        yield captured
      },
      async *streamSandboxLogs(request) {
        if (
          !request.since ||
          request.since.seconds * 1_000_000_000n + BigInt(request.since.nanos) <=
            seconds * 1_000_000_000n + BigInt(nanos)
        )
          yield captured
      },
    })
    const expected = new Date(iso)
    const fetched = await Array.fromAsync(
      sb.logs.fetch({since: new Date(expected.getTime() - 1000), until: new Date(expected.getTime() + 1000)}),
    )
    const tail = await Array.fromAsync(sb.logs.tail())
    const live = await Array.fromAsync(sb.logs.stream())
    for (const entries of [fetched, tail, live]) {
      assert.equal(entries[0]?.timestamp.toISOString(), iso)
      const replay = await Array.fromAsync(sb.logs.stream({replay: entries[0]!.timestamp}))
      assert.deepEqual(
        replay.map((e) => e.message),
        [record.message],
      )
    }
  })
}
