import {create} from '@bufbuild/protobuf'
import {timestampFromDate} from '@bufbuild/protobuf/wkt'
import {Code, ConnectError, createClient, createRouterTransport, type ServiceImpl} from '@connectrpc/connect'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {SandboxClient} from './client.js'
import {StreamCommandLogsResponseSchema} from './gen/depot/sandbox/v1/command_pb.js'
import {SandboxService} from './gen/depot/sandbox/v1/sandbox_pb.js'
import {Sandbox} from './sandbox.js'

const timestamp = timestampFromDate(new Date('2026-10-15T00:00:00Z'))
const entry = {data: new Uint8Array([255, 0]), stream: 'stdout', timestamp, lineNumber: 1n}
function client(overrides: Partial<ServiceImpl<typeof SandboxService>>): SandboxClient {
  return {
    endpoint: 'http://test',
    rpc: createClient(
      SandboxService,
      createRouterTransport(({service}) => {
        service(SandboxService, {getSandbox: () => ({sandbox: {sandboxId: 'sb', organizationId: 'org'}}), ...overrides})
      }),
    ),
  }
}

test('readLogs preserves bytes and independent completion and truncation', async () => {
  const sandbox = await Sandbox.get(
    client({
      readCommandLogs: (request) => {
        assert.equal(request.cmdId, 'cmd')
        assert.equal(request.sandbox?.selector.value, 'sb')
        assert.equal(request.limit, 10)
        return {entries: [entry], complete: true, truncated: true}
      },
    }),
    'sb',
  )
  const result = await sandbox.readLogs('cmd', {limit: 10})
  assert.equal(result.complete, true)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.entries[0]?.data, entry.data)
  assert.equal(result.entries[0]?.lineNumber, 1n)
})

test('streamLogs yields output and silent completion batches', async () => {
  const sandbox = await Sandbox.get(
    client({
      async *streamCommandLogs() {
        yield {entries: [entry]}
        yield {complete: true}
      },
    }),
    'sb',
  )
  const batches = await Array.fromAsync(sandbox.streamLogs('cmd'))
  assert.equal(batches.length, 2)
  assert.deepEqual(batches[0]?.entries[0]?.data, entry.data)
  assert.deepEqual(batches[1], {entries: [], complete: true})
})

test('streamLogs rejects closure without completion', async () => {
  const sandbox = await Sandbox.get(
    client({
      async *streamCommandLogs() {
        yield {entries: [entry]}
      },
    }),
    'sb',
  )
  await assert.rejects(
    Array.fromAsync(sandbox.streamLogs('cmd')),
    (error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable,
  )
})

test('breaking streamLogs cancels its call and closes its iterator', async () => {
  const sdkClient = client({})
  let closed = false
  let signal: AbortSignal | undefined
  sdkClient.rpc.streamCommandLogs = async function* (_request, options) {
    signal = options?.signal
    try {
      yield create(StreamCommandLogsResponseSchema, {entries: [entry]})
    } finally {
      closed = true
    }
  }
  const sandbox = await Sandbox.get(sdkClient, 'sb')
  for await (const _batch of sandbox.streamLogs('cmd')) break
  assert.equal(closed, true)
  assert.equal(signal?.aborted, true)
})

test('streamLogs forwards cancellation and deadline errors', async () => {
  const sandbox = await Sandbox.get(
    client({
      async *streamCommandLogs(_request, context) {
        yield {entries: [entry]}
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {once: true}),
        )
      },
    }),
    'sb',
  )
  const controller = new AbortController()
  const stream = sandbox.streamLogs('cmd', {signal: controller.signal})
  await stream.next()
  controller.abort()
  await assert.rejects(stream.next())
})
