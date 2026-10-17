import {create, toBinary, type MessageInitShape} from '@bufbuild/protobuf'
import {timestampFromDate} from '@bufbuild/protobuf/wkt'
import type {ServiceImpl} from '@connectrpc/connect'
import {connectNodeAdapter} from '@connectrpc/connect-node'
import {encodeEnvelope} from '@connectrpc/connect/protocol'
import assert from 'node:assert'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import http2 from 'node:http2'
import type {AddressInfo} from 'node:net'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import type {SandboxClient} from './client.js'
import {FileSystem} from './filesystem.js'
import {
  SandboxCommandExecutionEvent_FinishedSchema,
  SandboxCommandExecutionEvent_StartedSchema,
  SandboxCommandExecutionEventSchema,
  type SandboxCommandExecutionEvent,
} from './gen/depot/sandbox/v1/command_pb.js'
import type {SnapshotRef as SnapshotRefProto} from './gen/depot/sandbox/v1/refs_pb.js'
import {
  Architecture as ArchitectureProto,
  CreateSandboxResponseSchema,
  GetSandboxResponseSchema,
  ListSandboxesResponseSchema,
  SandboxSchema,
  SandboxService,
  SandboxStatus as SandboxStatusProto,
  SetSandboxTimeoutResponseSchema,
  SnapshotSandboxResponseSchema,
  StopSandboxResponseSchema,
  type SandboxConfiguration as SandboxConfigurationProto,
  type Sandbox as SandboxProto,
} from './gen/depot/sandbox/v1/sandbox_pb.js'
import {Sandbox, type CreateSandboxOpts, type SetTimeoutOpts} from './sandbox.js'
import type {Snapshot} from './types.js'

const CREATED_AT = new Date('2026-06-08T12:00:00.000Z')
const STARTED_AT = new Date('2026-06-08T12:00:01.000Z')
const FINISHED_AT = new Date('2026-06-08T12:00:02.000Z')
const EXPIRES_AT = new Date('2026-06-08T14:00:00.000Z')

type FakeClient = {
  client: SandboxClient
  calls: (name: string) => unknown[]
  lastRequest: (name: string) => unknown
}

function fakeClient(overrides: Partial<Record<string, (req: unknown) => unknown>>): FakeClient {
  const requests = new Map<string, unknown[]>()
  const handler = (name: string) => {
    const fn = overrides[name]
    if (!fn) throw new Error(`unexpected RPC call: ${name}`)
    return (req: unknown) => {
      const calls = requests.get(name) ?? []
      calls.push(req)
      requests.set(name, calls)
      return fn(req)
    }
  }
  const rpc = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return handler(prop)
      },
    },
  )
  return {
    client: {rpc, endpoint: 'http://test'} as unknown as SandboxClient,
    calls: (name: string) => requests.get(name) ?? [],
    lastRequest: (name: string) => {
      const calls = requests.get(name) ?? []
      return calls[calls.length - 1]
    },
  }
}

function makeSandbox(overrides: MessageInitShape<typeof SandboxSchema> = {}): SandboxProto {
  return create(SandboxSchema, {
    sandboxId: 'sbx_1',
    organizationId: 'org_1',
    status: SandboxStatusProto.RUNNING,
    createdAt: timestampFromDate(CREATED_AT),
    env: {BASE: 'sandbox'},
    ...overrides,
  })
}

function createResponse(sandbox: SandboxProto) {
  return create(CreateSandboxResponseSchema, {sandbox})
}

function makeStartedEvent(cmdId: string) {
  return create(SandboxCommandExecutionEventSchema, {
    event: {
      case: 'started',
      value: create(SandboxCommandExecutionEvent_StartedSchema, {cmdId, startedAt: timestampFromDate(STARTED_AT)}),
    },
  })
}

function makeFinishedEvent(exitCode: number) {
  return create(SandboxCommandExecutionEventSchema, {
    event: {
      case: 'finished',
      value: create(SandboxCommandExecutionEvent_FinishedSchema, {
        exitCode,
        finishedAt: timestampFromDate(FINISHED_AT),
      }),
    },
  })
}

test('Sandbox.create takes an explicit client and binds it to the returned sandbox', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_created'})),
    stopSandbox: () =>
      create(StopSandboxResponseSchema, {
        sandbox: makeSandbox({sandboxId: 'sbx_created', status: SandboxStatusProto.FINISHED}),
      }),
  })

  const sandbox = await Sandbox.create(recording.client, {name: 'explicit-client'})
  assert.equal(sandbox.sandboxId, 'sbx_created')
  assert.deepEqual(recording.lastRequest('createSandbox'), {
    name: 'explicit-client',
    resources: undefined,
    runtime: undefined,
    env: undefined,
    staging: undefined,
    timeoutMinutes: undefined,
    disableTailnet: undefined,
    disableDepotCache: undefined,
    configuration: undefined,
    architecture: undefined,
    snapshot: undefined,
  })

  await sandbox.stop()
  assert.deepEqual(recording.lastRequest('stopSandbox'), {
    sandbox: {selector: {case: 'id', value: 'sbx_created'}},
    blocking: undefined,
  })
})

test('Sandbox.get, list, and listAll bind returned sandboxes to the resolved client', async () => {
  const recording = fakeClient({
    getSandbox: () => create(GetSandboxResponseSchema, {sandbox: makeSandbox({sandboxId: 'sbx_get'})}),
    listSandboxes: (req) => {
      const pageToken = (req as {pageToken?: string}).pageToken
      if (!pageToken) {
        return create(ListSandboxesResponseSchema, {
          sandboxes: [makeSandbox({sandboxId: 'sbx_a'})],
          nextPageToken: 'next',
        })
      }
      return create(ListSandboxesResponseSchema, {sandboxes: [makeSandbox({sandboxId: 'sbx_b'})]})
    },
    stopSandbox: () =>
      create(StopSandboxResponseSchema, {
        sandbox: makeSandbox({sandboxId: 'sbx_b', status: SandboxStatusProto.FINISHED}),
      }),
  })

  const fetched = await Sandbox.get(recording.client, 'sbx_get')
  assert.equal(fetched.sandboxId, 'sbx_get')
  assert.deepEqual(recording.lastRequest('getSandbox'), {selector: {case: 'id', value: 'sbx_get'}})

  const page = await Sandbox.list(recording.client, {pagination: {pageSize: 1}})
  assert.deepEqual(
    page.sandboxes.map((sandbox) => sandbox.sandboxId),
    ['sbx_a'],
  )

  const all: Sandbox[] = []
  for await (const sandbox of Sandbox.listAll(recording.client, {pageSize: 1})) {
    all.push(sandbox)
  }
  assert.deepEqual(
    all.map((sandbox) => sandbox.sandboxId),
    ['sbx_a', 'sbx_b'],
  )

  await all[1]?.stop()
  assert.deepEqual(recording.lastRequest('stopSandbox'), {
    sandbox: {selector: {case: 'id', value: 'sbx_b'}},
    blocking: undefined,
  })
})

test('sandboxes fetched from different clients keep using their originating clients', async () => {
  const clientA = fakeClient({
    listSandboxes: () => create(ListSandboxesResponseSchema, {sandboxes: [makeSandbox({sandboxId: 'sbx_a'})]}),
    stopSandbox: () =>
      create(StopSandboxResponseSchema, {
        sandbox: makeSandbox({sandboxId: 'sbx_a', status: SandboxStatusProto.FINISHED}),
      }),
  })
  const clientB = fakeClient({
    getSandbox: () => create(GetSandboxResponseSchema, {sandbox: makeSandbox({sandboxId: 'sbx_b'})}),
    stopSandbox: () =>
      create(StopSandboxResponseSchema, {
        sandbox: makeSandbox({sandboxId: 'sbx_b', status: SandboxStatusProto.FINISHED}),
      }),
  })

  const pageA = await Sandbox.list(clientA.client)
  const sandboxB = await Sandbox.get(clientB.client, 'sbx_b')

  await pageA.sandboxes[0]?.stop()
  await sandboxB.stop()

  assert.equal(clientA.calls('stopSandbox').length, 1)
  assert.equal(clientB.calls('stopSandbox').length, 1)
  assert.deepEqual(clientA.lastRequest('stopSandbox'), {
    sandbox: {selector: {case: 'id', value: 'sbx_a'}},
    blocking: undefined,
  })
  assert.deepEqual(clientB.lastRequest('stopSandbox'), {
    sandbox: {selector: {case: 'id', value: 'sbx_b'}},
    blocking: undefined,
  })
})

test('Sandbox.create sends timeoutMinutes when provided', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_timeout'})),
  })

  await Sandbox.create(recording.client, {timeoutMinutes: 120})

  assert.deepEqual(recording.lastRequest('createSandbox'), {
    name: undefined,
    resources: undefined,
    runtime: undefined,
    env: undefined,
    staging: undefined,
    timeoutMinutes: 120,
    disableTailnet: undefined,
    disableDepotCache: undefined,
    configuration: undefined,
    architecture: undefined,
    snapshot: undefined,
  })
})

test('Sandbox.create omits timeoutMinutes when no timeout is requested', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_default'})),
  })

  await Sandbox.create(recording.client, {})

  const request = recording.lastRequest('createSandbox') as {timeoutMinutes?: number}
  assert.equal(request.timeoutMinutes, undefined)
})

test('Sandbox.create rejects invalid timeoutMinutes before any RPC', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_invalid'})),
  })

  for (const timeoutMinutes of [0, -5, 2.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(Sandbox.create(recording.client, {timeoutMinutes}), TypeError)
  }
  assert.equal(recording.calls('createSandbox').length, 0, 'invalid input must fail before the RPC is issued')
})

test('Sandbox.create sends configuration with secrets and variant scope', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_secrets'})),
  })

  await Sandbox.create(recording.client, {
    env: {DATABASE_URL: 'unused'},
    configuration: {
      secrets: {DATABASE_URL: 'PROD_DATABASE_URL', _TOKEN2: 'API_TOKEN'},
      environment: 'production',
      repository: 'acme/app',
    },
  })

  const request = recording.lastRequest('createSandbox') as {
    env?: Record<string, string>
    configuration?: SandboxConfigurationProto
  }
  assert.deepEqual(request.env, {DATABASE_URL: 'unused'})
  assert.equal(request.configuration?.$typeName, 'depot.sandbox.v1.SandboxConfiguration')
  assert.deepEqual(
    request.configuration?.secrets.map(({env, secret}) => ({env, secret})),
    [
      {env: 'DATABASE_URL', secret: 'PROD_DATABASE_URL'},
      {env: '_TOKEN2', secret: 'API_TOKEN'},
    ],
  )
  assert.equal(request.configuration?.environment, 'production')
  assert.equal(request.configuration?.repository, 'acme/app')
})

test('Sandbox.create leaves the variant scope unset when not provided', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_unscoped'})),
  })

  await Sandbox.create(recording.client, {configuration: {secrets: {NPM_TOKEN: 'NPM_TOKEN'}}})

  const request = recording.lastRequest('createSandbox') as {configuration?: SandboxConfigurationProto}
  assert.deepEqual(
    request.configuration?.secrets.map(({env, secret}) => ({env, secret})),
    [{env: 'NPM_TOKEN', secret: 'NPM_TOKEN'}],
  )
  assert.equal(request.configuration?.environment, undefined)
  assert.equal(request.configuration?.repository, undefined)
})

test('Sandbox.create rejects legacy timeoutMs before any RPC', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_legacy_timeout'})),
  })

  await assert.rejects(
    Sandbox.create(recording.client, {timeoutMs: 60_000} as unknown as CreateSandboxOpts),
    /timeoutMs was replaced by timeoutMinutes/,
  )
  assert.equal(recording.calls('createSandbox').length, 0, 'legacy input must fail before the RPC is issued')
})

test('Sandbox.setTimeout resets the deadline using the bound client', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_keepalive'})),
    setSandboxTimeout: () =>
      create(SetSandboxTimeoutResponseSchema, {
        sandbox: makeSandbox({
          sandboxId: 'sbx_keepalive',
          expiresAt: timestampFromDate(EXPIRES_AT),
        }),
      }),
  })

  const sandbox = await Sandbox.create(recording.client)
  await sandbox.setTimeout({timeoutMinutes: 60})

  assert.deepEqual(recording.lastRequest('setSandboxTimeout'), {
    sandbox: {selector: {case: 'id', value: 'sbx_keepalive'}},
    timeoutMinutes: 60,
  })
  assert.deepEqual(sandbox.expiresAt, EXPIRES_AT)

  const callCount = recording.calls('setSandboxTimeout').length
  for (const timeoutMinutes of [0, -5, 2.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(sandbox.setTimeout({timeoutMinutes}), TypeError)
  }
  assert.equal(
    recording.calls('setSandboxTimeout').length,
    callCount,
    'invalid input must fail before the RPC is issued',
  )

  await assert.rejects(
    sandbox.setTimeout({timeoutMs: 60_000} as unknown as SetTimeoutOpts),
    /timeoutMs was replaced by timeoutMinutes/,
  )
  assert.equal(
    recording.calls('setSandboxTimeout').length,
    callCount,
    'legacy input must fail before the RPC is issued',
  )
})

test('Sandbox instance methods use the client captured at creation', async () => {
  async function* runCommandStream() {
    yield makeStartedEvent('cmd_1')
    yield makeFinishedEvent(0)
  }
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_bound'})),
    stopSandbox: () =>
      create(StopSandboxResponseSchema, {
        sandbox: makeSandbox({sandboxId: 'sbx_bound', status: SandboxStatusProto.FINISHED}),
      }),
    killSandbox: () => ({sandbox: makeSandbox({sandboxId: 'sbx_bound', status: SandboxStatusProto.CANCELLED})}),
    runCommand: () => runCommandStream(),
    mkdir: () => ({}),
  })

  const sandbox = await Sandbox.create(recording.client, {env: {BASE: 'sandbox'}})

  await sandbox.stop({blocking: true})
  assert.deepEqual(recording.lastRequest('stopSandbox'), {
    sandbox: {selector: {case: 'id', value: 'sbx_bound'}},
    blocking: true,
  })

  await sandbox.kill({signal: 'SIGKILL'})
  assert.deepEqual(recording.lastRequest('killSandbox'), {
    sandbox: {selector: {case: 'id', value: 'sbx_bound'}},
    signal: 'SIGKILL',
  })

  const command = await sandbox.runCommand({cmd: 'echo', args: ['hi'], env: {EXTRA: '1'}})
  const finished = await command.wait()
  assert.equal(finished.exitCode, 0)
  assert.deepEqual(recording.lastRequest('runCommand'), {
    sandbox: {selector: {case: 'id', value: 'sbx_bound'}},
    cmd: 'echo',
    args: ['hi'],
    cwd: undefined,
    env: {EXTRA: '1'},
    sudo: undefined,
    detached: undefined,
  })
  assert.deepEqual({...command.env}, {BASE: 'sandbox', EXTRA: '1'})

  const fs = sandbox.fs()
  assert.ok(fs instanceof FileSystem)
  await fs.mkdir('/work')
  assert.deepEqual(recording.lastRequest('mkdir'), {
    sandbox: {selector: {case: 'id', value: 'sbx_bound'}},
    path: '/work',
    recursive: undefined,
    mode: undefined,
  })
})

function assertSandboxTypeContract(sandbox: Sandbox, client: SandboxClient): void {
  void Sandbox.create(client)
  void Sandbox.get(client, 'sbx_1')
  void Sandbox.list(client)
  void Sandbox.listAll(client)
  void sandbox.stop()
  void sandbox.kill()
  void sandbox.runCommand({cmd: 'echo'})
  void sandbox.fs()
  void Sandbox.create(client, {timeoutMinutes: 10})
  void sandbox.setTimeout({timeoutMinutes: 10})
}

void assertSandboxTypeContract

test('Sandbox.create forwards disableTailnet', async () => {
  const recording = fakeClient({createSandbox: () => createResponse(makeSandbox())})
  await Sandbox.create(recording.client, {disableTailnet: true})
  assert.equal((recording.lastRequest('createSandbox') as {disableTailnet?: boolean}).disableTailnet, true)
})

test('Sandbox.create forwards disableDepotCache', async () => {
  const recording = fakeClient({createSandbox: () => createResponse(makeSandbox())})
  await Sandbox.create(recording.client, {disableDepotCache: true})
  assert.equal((recording.lastRequest('createSandbox') as {disableDepotCache?: boolean}).disableDepotCache, true)
})

test('Sandbox.create sends architecture and exposes the resolved one', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({architecture: ArchitectureProto.ARM64})),
  })
  const sandbox = await Sandbox.create(recording.client, {architecture: 'arm64'})
  assert.equal(
    (recording.lastRequest('createSandbox') as {architecture?: ArchitectureProto}).architecture,
    ArchitectureProto.ARM64,
  )
  assert.equal(sandbox.architecture, 'arm64')
})

test('Sandbox.create leaves architecture unset by default', async () => {
  const recording = fakeClient({createSandbox: () => createResponse(makeSandbox())})
  const sandbox = await Sandbox.create(recording.client)
  assert.equal((recording.lastRequest('createSandbox') as {architecture?: ArchitectureProto}).architecture, undefined)
  assert.equal(sandbox.architecture, undefined, 'UNSPECIFIED from an older server maps to undefined')
})

test('sandbox.snapshot sends the sandbox ref and maps the returned Snapshot', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox({sandboxId: 'sbx_src'})),
    snapshotSandbox: () =>
      create(SnapshotSandboxResponseSchema, {
        snapshot: {
          snapshotId: 'snap_1',
          sourceSandboxId: 'sbx_src',
          createdAt: timestampFromDate(CREATED_AT),
          sizeBytes: 2048n,
          fileCount: 3n,
          runtime: {runtime: {case: 'imageRef', value: 'registry.depot.dev/x:y'}},
          architecture: ArchitectureProto.ARM64,
        },
      }),
  })
  const sandbox = await Sandbox.create(recording.client)
  const snapshot = await sandbox.snapshot()
  assert.deepEqual(recording.lastRequest('snapshotSandbox'), {sandbox: {selector: {case: 'id', value: 'sbx_src'}}})
  assert.deepEqual(snapshot, {
    snapshotId: 'snap_1',
    sourceSandboxId: 'sbx_src',
    createdAt: CREATED_AT,
    sizeBytes: 2048,
    fileCount: 3,
    runtime: {imageRef: 'registry.depot.dev/x:y'},
    architecture: 'arm64',
  })
})

test('sandbox.snapshot throws when the response has no snapshot', async () => {
  const recording = fakeClient({
    createSandbox: () => createResponse(makeSandbox()),
    snapshotSandbox: () => create(SnapshotSandboxResponseSchema, {}),
  })
  const sandbox = await Sandbox.create(recording.client)
  await assert.rejects(sandbox.snapshot(), /SnapshotSandbox response missing `snapshot`/)
})

test('Sandbox.create accepts a Snapshot or a snapshot id', async () => {
  const recording = fakeClient({createSandbox: () => createResponse(makeSandbox())})
  const snapshotOf = () => (recording.lastRequest('createSandbox') as {snapshot?: SnapshotRefProto}).snapshot?.selector
  await Sandbox.create(recording.client, {snapshot: 'snap_by_id'})
  assert.deepEqual(snapshotOf(), {case: 'id', value: 'snap_by_id'})
  const snapshot: Snapshot = {
    snapshotId: 'snap_obj',
    sourceSandboxId: 'sbx_1',
    createdAt: CREATED_AT,
    sizeBytes: 0,
    fileCount: 0,
    runtime: undefined,
    architecture: undefined,
  }
  await Sandbox.create(recording.client, {snapshot})
  assert.deepEqual(snapshotOf(), {case: 'id', value: 'snap_obj'})
})

// Runs a script against a real HTTP/2 server in a child process and reports
// whether that process exits on its own, the thing a stream leak breaks.
// rawRunCommand's last frame lands after the client has read the others, as the
// live API's end-of-stream frame can land after Finished.
async function childExits(
  scenario: string,
  impl: Partial<ServiceImpl<typeof SandboxService>>,
  rawRunCommand?: {frames: Uint8Array[]; last: Uint8Array},
): Promise<boolean> {
  const adapter = connectNodeAdapter({
    routes: (r) => r.service(SandboxService, {getSandbox: () => ({sandbox: makeSandbox()}), ...impl}),
  })
  const server = http2.createServer((req, res) => {
    if (!rawRunCommand || !req.url.endsWith('/RunCommand')) return adapter(req, res)
    req.resume()
    res.writeHead(200, {'content-type': 'application/connect+proto'})
    for (const frame of rawRunCommand.frames) res.write(frame)
    setTimeout(() => res.end(rawRunCommand.last), 100)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  const script = `
    const [client, sandbox, endpoint, scenario] = process.argv.slice(1)
    const {createClient} = await import(client)
    const {Sandbox} = await import(sandbox)
    const box = await Sandbox.get(createClient({token: 't', endpoint}), 'sbx_1')
    if (scenario === 'wait') await (await box.runCommand({cmd: 'echo'})).wait()
    if (scenario === 'detached') await box.runCommand({cmd: 'sleep', detached: true})
    if (scenario === 'break') for await (const _ of box.logs.tail()) { await new Promise((r) => setTimeout(r, 100)); break }`
  const src = (file: string) => fileURLToPath(new URL(file, import.meta.url))
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      src('client.ts'),
      src('sandbox.ts'),
      `http://127.0.0.1:${port}`,
      scenario,
    ],
    {stdio: 'inherit'},
  )
  try {
    const timeout = setTimeout(() => child.kill(), 5000)
    const [code] = (await once(child, 'exit')) as [number | null]
    clearTimeout(timeout)
    return code === 0
  } finally {
    server.close()
  }
}

test('the process exits after runCommand wait()', async () => {
  const event = (e: SandboxCommandExecutionEvent) => encodeEnvelope(0, toBinary(SandboxCommandExecutionEventSchema, e))
  const exits = await childExits(
    'wait',
    {},
    {
      frames: [event(makeStartedEvent('cmd_1')), event(makeFinishedEvent(0))],
      last: encodeEnvelope(2, new TextEncoder().encode('{}')),
    },
  )
  assert.equal(exits, true)
})

test('the process exits after a detached runCommand', async () => {
  const exits = await childExits('detached', {
    async *runCommand(_req, context) {
      yield makeStartedEvent('cmd_1')
      await once(context.signal, 'abort')
    },
  })
  assert.equal(exits, true)
})

test('the process exits after breaking out of a log iterator', async () => {
  const exits = await childExits('break', {
    async *tailSandboxLogs() {
      for (const message of ['a', 'b', 'c']) yield {message, source: 'stdout', timestamp: timestampFromDate(STARTED_AT)}
    },
  })
  assert.equal(exits, true)
})
