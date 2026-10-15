import {create} from '@bufbuild/protobuf'
import {timestampDate, timestampFromDate, type Timestamp} from '@bufbuild/protobuf/wkt'
import {Code, ConnectError} from '@connectrpc/connect'
import {setTimeout as delay} from 'node:timers/promises'
import type {SandboxClient} from './client.js'
import {_commandInternals, type SandboxCommandExecution} from './command.js'
import {FileSystem} from './filesystem.js'
import type {
  SandboxCommandLogEntry as LogEntryProto,
  SandboxCommandExecutionEvent,
} from './gen/depot/sandbox/v1/command_pb.js'
import {
  Architecture as ArchitectureProto,
  ListSandboxesRequest_FilterSchema,
  RuntimeSchema,
  SandboxConfigurationSchema,
  SandboxStatus as SandboxStatusProto,
  type ListSandboxesRequest_Filter as ListSandboxesFilterProto,
  type NetworkUsage as NetworkUsageProto,
  type Runtime as RuntimeProto,
  type SandboxConfiguration as SandboxConfigurationProto,
  type Sandbox as SandboxProto,
} from './gen/depot/sandbox/v1/sandbox_pb.js'
import {SandboxTailnet} from './tailnet.js'
import type {
  Architecture,
  ListFilter,
  NetworkUsage,
  Pagination,
  PaginationResult,
  ReadLogsOpts,
  Resources,
  RunCommandOpts,
  Runtime,
  SandboxCommandLogBatch,
  SandboxCommandLogEntry,
  SandboxCommandLogs,
  SandboxConfiguration,
  SandboxStatus,
  StreamLogsOpts,
} from './types.js'

/**
 * A sandbox. Each instance represents one sandbox running on the server.
 *
 * You don't construct this directly; use {@link Sandbox.create},
 * {@link Sandbox.get}, {@link Sandbox.list}, or {@link Sandbox.listAll}.
 */
export class Sandbox {
  readonly sandboxId: string
  readonly organizationId: string
  protected readonly client: SandboxClient

  protected _status: SandboxStatus | undefined
  protected _resources: Resources | undefined
  protected _runtime: Runtime | undefined
  protected _architecture: Architecture | undefined
  protected _createdAt: Date | undefined
  protected _startedAt: Date | undefined
  protected _stoppedAt: Date | undefined
  protected _expiresAt: Date | undefined
  protected _activeCpuUsageMs: number | undefined
  protected _networkUsage: NetworkUsage | undefined
  protected _exitCode: number | undefined
  protected _errorMessage: string | undefined
  protected _name: string | undefined
  // The sandbox's environment variables, as reported by the server. The
  // server merges these into every command it runs, so callers can read
  // them here without holding onto the original create options.
  protected _env: Record<string, string> = {}

  protected constructor(opts: {client: SandboxClient; sandboxId: string; organizationId: string}) {
    this.client = opts.client
    this.sandboxId = opts.sandboxId
    this.organizationId = opts.organizationId
  }

  /**
   * The sandbox's current lifecycle status. Undefined when the server hasn't
   * yet assigned one.
   */
  get status(): SandboxStatus | undefined {
    return this._status
  }

  /** The resources the server actually allocated to this sandbox. */
  get resources(): Resources | undefined {
    return this._resources
  }

  /** The runtime the server actually resolved for this sandbox. */
  get runtime(): Runtime | undefined {
    return this._runtime
  }

  /** The CPU architecture the sandbox runs on. Undefined only from a server that predates the field. */
  get architecture(): Architecture | undefined {
    return this._architecture
  }

  /** When the sandbox was created. Always set. */
  get createdAt(): Date | undefined {
    return this._createdAt
  }

  /** When the sandbox finished booting and started running. */
  get startedAt(): Date | undefined {
    return this._startedAt
  }

  /** When the sandbox stopped, if it has reached a terminal status. */
  get stoppedAt(): Date | undefined {
    return this._stoppedAt
  }

  /** When the sandbox will expire, if it has a timeout. */
  get expiresAt(): Date | undefined {
    return this._expiresAt
  }

  /**
   * Total CPU time the sandbox used, in milliseconds. Only populated once the
   * sandbox has stopped, and only when the server reports metering. It stays
   * undefined until server-side metering is in place.
   */
  get activeCpuUsageMs(): number | undefined {
    return this._activeCpuUsageMs
  }

  /**
   * Bytes the sandbox sent and received over the network. Populated under the
   * same conditions as {@link activeCpuUsageMs}.
   */
  get networkUsage(): NetworkUsage | undefined {
    return this._networkUsage
  }

  /** Exit code of the sandbox's main process. */
  get exitCode(): number | undefined {
    return this._exitCode
  }

  /** A description of the failure, when the sandbox ended with an error. */
  get errorMessage(): string | undefined {
    return this._errorMessage
  }

  /** The human-readable label set when the sandbox was created, if any. */
  get name(): string | undefined {
    return this._name
  }

  /** The sandbox's connection to your organization's tailnet. */
  get tailnet(): SandboxTailnet {
    return new SandboxTailnet({run: (opts) => this.runCommand(opts)})
  }

  /** Create a new sandbox. */
  static async create(client: SandboxClient, opts: CreateSandboxOpts = {}): Promise<Sandbox> {
    assertNoLegacyTimeoutMs(opts)
    if (opts.timeoutMinutes !== undefined) assertTimeoutMinutes(opts.timeoutMinutes)
    const response = await client.rpc.createSandbox({
      name: opts.name,
      resources: opts.resources,
      runtime: opts.runtime !== undefined ? runtimeToProto(opts.runtime) : undefined,
      env: opts.env,
      staging: opts.staging,
      timeoutMinutes: opts.timeoutMinutes,
      disableTailnet: opts.disableTailnet,
      configuration: opts.configuration !== undefined ? configurationToProto(opts.configuration) : undefined,
      architecture: opts.architecture !== undefined ? architectureToProto(opts.architecture) : undefined,
    })
    const sandbox = response.sandbox
    if (!sandbox) {
      throw new Error('CreateSandbox response missing `sandbox`')
    }
    return Sandbox.fromProto(sandbox, client)
  }

  /** Fetch a sandbox by its id. */
  static async get(client: SandboxClient, sandboxId: string): Promise<Sandbox> {
    const response = await client.rpc.getSandbox({selector: {case: 'id', value: sandboxId}})
    const sandbox = response.sandbox
    if (!sandbox) {
      throw new Error('GetSandbox response missing `sandbox`')
    }
    return Sandbox.fromProto(sandbox, client)
  }

  /**
   * Fetch a single page of sandboxes. To page through all of them
   * automatically, use {@link Sandbox.listAll}.
   */
  static async list(client: SandboxClient, opts: ListSandboxesOpts = {}): Promise<ListSandboxesResult> {
    const response = await client.rpc.listSandboxes({
      pageSize: opts.pagination?.pageSize,
      pageToken: opts.pagination?.pageToken,
      filter: opts.filter !== undefined ? filterToProto(opts.filter) : undefined,
    })
    return {
      sandboxes: response.sandboxes.map((s) => Sandbox.fromProto(s, client)),
      pagination: {nextPageToken: response.nextPageToken || undefined},
    }
  }

  /** @internal Build a Sandbox from the proto returned by the server. */
  protected static fromProto(sandbox: SandboxProto, client: SandboxClient): Sandbox {
    const instance = new Sandbox({
      client,
      sandboxId: sandbox.sandboxId,
      organizationId: sandbox.organizationId,
    })
    instance.applyProto(sandbox)
    return instance
  }

  /**
   * Iterate over every sandbox, fetching pages as needed. Yields one sandbox
   * at a time and keeps requesting pages until the server has none left.
   */
  static async *listAll(client: SandboxClient, opts: ListAllSandboxesOpts = {}): AsyncIterable<Sandbox> {
    let pageToken: string | undefined = undefined
    while (true) {
      const page: ListSandboxesResult = await Sandbox.list(client, {
        filter: opts.filter,
        pagination: {pageSize: opts.pageSize, pageToken},
      })
      for (const sandbox of page.sandboxes) yield sandbox
      pageToken = page.pagination.nextPageToken
      if (!pageToken) return
    }
  }

  /**
   * Stop the sandbox gracefully. The sandbox ends in the `finished` status.
   *
   * With `opts.blocking` set, the server waits for the sandbox to finish
   * cleaning up before it responds. By default it returns as soon as it has
   * recorded the stop request, and you can poll {@link Sandbox.get} to watch
   * for the status to change.
   *
   * This updates the instance in place from the server's response, and throws
   * if the sandbox has already stopped.
   */
  async stop(opts: StopSandboxOpts = {}): Promise<void> {
    const response = await this.client.rpc.stopSandbox({
      sandbox: {selector: {case: 'id', value: this.sandboxId}},
      blocking: opts.blocking,
    })
    if (response.sandbox) this.applyProto(response.sandbox)
  }

  /**
   * Kill the sandbox immediately. The sandbox ends in the `cancelled` status.
   *
   * `opts.signal` is accepted but currently ignored: every kill is a hard
   * cancel regardless of the signal you pass. Support for forwarding the
   * signal to the sandbox is planned for a later release.
   *
   * Throws if the sandbox has already stopped.
   */
  async kill(opts: KillSandboxOpts = {}): Promise<void> {
    const response = await this.client.rpc.killSandbox({
      sandbox: {selector: {case: 'id', value: this.sandboxId}},
      signal: opts.signal,
    })
    if (response.sandbox) this.applyProto(response.sandbox)
  }

  /**
   * Set this running sandbox's expiry to a fresh deadline. The server clamps
   * the new deadline to the sandbox's absolute maximum lifetime, measured from
   * when it started. For example:
   * `sandbox.setTimeout({timeoutMinutes: 240})`.
   *
   * To keep a sandbox alive while it's in active use, call this on an interval
   * shorter than the timeout you set; when the calls stop, the server
   * terminates the sandbox once the deadline lapses. Throws if the sandbox has
   * not started, already expired, or reached a terminal status.
   *
   * This updates the instance in place (`expiresAt`) from the server's
   * response, and throws if the sandbox has already stopped.
   */
  async setTimeout(opts: SetTimeoutOpts): Promise<void> {
    assertNoLegacyTimeoutMs(opts)
    assertTimeoutMinutes(opts.timeoutMinutes)
    const response = await this.client.rpc.setSandboxTimeout({
      sandbox: {selector: {case: 'id', value: this.sandboxId}},
      timeoutMinutes: opts.timeoutMinutes,
    })
    if (response.sandbox) this.applyProto(response.sandbox)
  }

  /** Read completed command logs, retrying unavailable output within one second. */
  readLogs(cmdId: string, opts: ReadLogsOpts & {encoding: 'buffer'}): Promise<SandboxCommandLogs<Uint8Array>>
  readLogs(cmdId: string, opts?: ReadLogsOpts & {encoding?: BufferEncoding}): Promise<SandboxCommandLogs>
  readLogs(cmdId: string, opts: ReadLogsOpts): Promise<SandboxCommandLogs<string | Uint8Array>>
  async readLogs(cmdId: string, opts: ReadLogsOpts = {}): Promise<SandboxCommandLogs<string | Uint8Array>> {
    const encoding = commandLogEncoding(opts.encoding)
    const requestedTimeout = opts.timeoutMs ?? 1000
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw new ConnectError('timeoutMs must be positive and finite', Code.InvalidArgument)
    }
    const deadline = performance.now() + Math.min(requestedTimeout, 1000)
    let retryDelay = 50
    let unavailable: ConnectError | undefined
    while (true) {
      if (opts.signal?.aborted) throw ConnectError.from(opts.signal.reason, Code.Canceled)
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0) throw unavailable ?? new ConnectError('Log read deadline exceeded', Code.DeadlineExceeded)
      try {
        const response = await this.client.rpc.readCommandLogs(
          {
            sandbox: {selector: {case: 'id', value: this.sandboxId}},
            cmdId,
            limit: opts.limit,
          },
          {signal: opts.signal, timeoutMs: remaining},
        )
        return {
          entries: response.entries.map((entry) => commandLogEntry(entry, encoding)),
          complete: response.complete,
          truncated: response.truncated,
        }
      } catch (error) {
        if (opts.signal?.aborted) throw ConnectError.from(opts.signal.reason, Code.Canceled)
        const failure = ConnectError.from(error)
        if (failure.code !== Code.Unavailable) {
          if (failure.code === Code.DeadlineExceeded && unavailable && performance.now() >= deadline - 1)
            throw unavailable
          throw failure
        }
        unavailable = failure
      }
      if (retryDelay >= deadline - performance.now()) throw unavailable
      try {
        await delay(retryDelay, undefined, {signal: opts.signal})
      } catch (error) {
        throw ConnectError.from(opts.signal?.reason ?? error, Code.Canceled)
      }
      retryDelay += 50
    }
  }

  /** Replay retained Tail records, then follow new output until the platform reports completion.
   * Accepts the command returned by runCommand() or its cmdId.
   * Breaking iteration cancels the upstream subscription. Platform resets fail
   * the stream; use readLogs() to retrieve historical output.
   */
  streamLogs(
    command: SandboxCommandExecution | string,
    opts: StreamLogsOpts & {encoding: 'buffer'},
  ): AsyncGenerator<SandboxCommandLogBatch<Uint8Array>>
  streamLogs(
    command: SandboxCommandExecution | string,
    opts?: StreamLogsOpts & {encoding?: BufferEncoding},
  ): AsyncGenerator<SandboxCommandLogBatch>
  streamLogs(
    command: SandboxCommandExecution | string,
    opts: StreamLogsOpts,
  ): AsyncGenerator<SandboxCommandLogBatch<string | Uint8Array>>
  async *streamLogs(
    command: SandboxCommandExecution | string,
    opts: StreamLogsOpts = {},
  ): AsyncGenerator<SandboxCommandLogBatch<string | Uint8Array>> {
    const encoding = commandLogEncoding(opts.encoding)
    const controller = new AbortController()
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
    let complete = false
    try {
      for await (const response of this.client.rpc.streamCommandLogs(
        {
          sandbox: {selector: {case: 'id', value: this.sandboxId}},
          cmdId: typeof command === 'string' ? command : command.cmdId,
        },
        {signal, timeoutMs: opts.timeoutMs},
      )) {
        complete ||= response.complete
        yield {entries: response.entries.map((entry) => commandLogEntry(entry, encoding)), complete: response.complete}
      }
      if (!complete) throw new ConnectError('Log stream closed before command completion', Code.Unavailable)
    } finally {
      controller.abort()
    }
  }

  /**
   * Run a command in this sandbox. This is a server-streaming call, and it
   * returns the {@link SandboxCommandExecution} as soon as the server reports
   * that the command has started, rather than waiting for it to finish. That
   * lets you attach `.logs()`/`.output()` iterators and watch output while the
   * command is still running. Call `.wait()` on the returned execution to get
   * the settled {@link SandboxCommandExecutionFinished} view:
   *
   * ```ts
   * const cmd = await sandbox.runCommand({cmd: 'echo hi'})
   * const result = await cmd.wait()
   * console.log(result.exitCode, await cmd.output())
   * ```
   *
   * Returning early is what makes concurrent log streaming possible. The
   * stream is buffered with a bounded amount of memory, so if we waited for
   * the command to finish before handing control back, the start of the
   * output could be discarded before any consumer had a chance to read it.
   * Internally we open the stream, build the execution from the start event,
   * then drain the rest of the stream into that buffer in the background;
   * concurrent `.logs()` callers each get an independent iterator backed by
   * the shared buffer.
   *
   * Detached commands keep running after this method returns. Read their retained
   * output with readLogs() or follow it with streamLogs(). Execution-object
   * logs(), output(), and wait() remain unavailable in detached mode.
   */
  async runCommand(opts: RunCommandOpts): Promise<SandboxCommandExecution> {
    const stream = this.client.rpc.runCommand({
      sandbox: {selector: {case: 'id', value: this.sandboxId}},
      cmd: opts.cmd,
      args: opts.args ?? [],
      cwd: opts.cwd,
      env: opts.env ?? {},
      sudo: opts.sudo,
      detached: opts.detached,
    })

    // Pull the first event; it MUST be Started so the SDK can build the
    // SandboxCommandExecution instance with the server-minted cmd_id. Anything else
    // (including a missing oneof case) is a protocol violation. We don't
    // use for-await-of here because we hand the iterator off to
    // drainStream once Started lands; the cost is that the implicit
    // cleanup for-await-of provides doesn't apply, so any early-exit
    // path has to call iterator.return() explicitly or the underlying
    // HTTP/2 stream stays open until GC.
    const iterator = stream[Symbol.asyncIterator]()
    let startedEvent: SandboxCommandExecutionEvent
    try {
      const first = await iterator.next()
      if (first.done) {
        throw new ConnectError('RunCommand stream closed before Started event', Code.Internal)
      }
      startedEvent = first.value
      if (startedEvent.event.case !== 'started') {
        throw new ConnectError(
          `RunCommand stream first event was ${startedEvent.event.case ?? 'unknown'}, expected started`,
          Code.Internal,
        )
      }
    } catch (err) {
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return()
        } catch {
          // ignore — best-effort cleanup
        }
      }
      throw err
    }
    const startedAt =
      startedEvent.event.value.startedAt !== undefined ? timestampDate(startedEvent.event.value.startedAt) : new Date()

    // Merge sandbox-level env + request env (request wins on collisions) so
    // SandboxCommandExecution.env on the returned instance matches what the server actually
    // executes and what a later GetCommand snapshot reads back. The server
    // performs the same merge before persisting the SandboxCommandExecution row.
    const mergedEnv = {...this._env, ...opts.env}
    const command = _commandInternals.fromStartedEvent({
      cmdId: startedEvent.event.value.cmdId,
      sandboxId: this.sandboxId,
      cmd: opts.cmd,
      args: opts.args ?? [],
      cwd: opts.cwd,
      env: mergedEnv,
      sudo: opts.sudo ?? false,
      detached: opts.detached ?? false,
      startedAt,
    })

    // Replay the Started event into the buffer so `logs()` consumers
    // attached before the next event arrives see the same Started → ... →
    // Finished sequence a fresh AttachCommand would receive.
    _commandInternals.ingest(command, startedEvent)

    if (opts.detached) {
      // Fire-and-forget: the server ends the stream right after Started and
      // keeps the command running in the sandbox. There is no further output to
      // pump, so close the iterator instead of draining it — draining would see
      // the stream end without a Finished event and wrongly mark the command
      // failed. logs(), output(), and wait() throw for detached commands.
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return()
        } catch {
          // ignore — best-effort cleanup
        }
      }
      return command
    }

    // Background pump: drain the stream into the buffer. We don't await the
    // pump directly — callers observe Finished via `command.wait()`, which
    // subscribes to the buffer. Errors on the stream propagate via
    // events.error().
    // drainStream owns its own try/catch and routes errors to
    // _commandInternals.fail(), so the returned promise never rejects;
    // a `.catch()` here would be dead code. We still need to consume the
    // promise so an uncaught-rejection lint doesn't fire if drainStream
    // is ever changed to surface errors — void-mark it explicitly.
    void drainStream(command, iterator)

    return command
  }

  /**
   * The sandbox's file system, as a {@link FileSystem} bound to this sandbox.
   * Its methods mirror `node:fs/promises`:
   *
   * ```ts
   * const fs = sandbox.fs()
   * await fs.mkdir('/work', {recursive: true})
   * await fs.writeFile('/work/hello.txt', 'hi')
   * const stat = await fs.stat('/work/hello.txt')
   * ```
   *
   * Each call returns a fresh, lightweight {@link FileSystem} bound to the same
   * sandbox and client.
   */
  fs(): FileSystem {
    return new FileSystem({client: this.client, sandboxId: this.sandboxId})
  }

  /** @internal Refresh this instance's fields from a proto returned by the server. */
  protected applyProto(sandbox: SandboxProto): void {
    this._status = sandboxStatusFromProto(sandbox.status)
    this._resources = resourcesFromProto(sandbox)
    this._runtime = runtimeFromProto(sandbox)
    this._architecture = architectureFromProto(sandbox.architecture)
    this._createdAt = timestampToDate(sandbox.createdAt)
    this._startedAt = timestampToDate(sandbox.startedAt)
    this._stoppedAt = timestampToDate(sandbox.stoppedAt)
    this._expiresAt = timestampToDate(sandbox.expiresAt)
    this._activeCpuUsageMs = bigintToNumber(sandbox.activeCpuUsageMs)
    this._networkUsage = networkUsageFromProto(sandbox.networkUsage)
    this._exitCode = sandbox.exitCode
    this._errorMessage = sandbox.errorMessage
    this._name = sandbox.name
    this._env = {...sandbox.env}
  }

  /**
   * The environment variables the server merges into every command run on
   * this sandbox. Empty if the sandbox was created without any, or if it was
   * fetched from a server that doesn't report them.
   */
  get env(): Readonly<Record<string, string>> {
    return this._env
  }
}

/** Options for {@link Sandbox.stop}. */
export interface StopSandboxOpts {
  /**
   * Wait for the sandbox to finish cleaning up before resolving. By default
   * the call resolves as soon as the server records the stop request, and you
   * can poll {@link Sandbox.get} to watch for the status to change.
   */
  blocking?: boolean
}

/** Options for {@link Sandbox.kill}. */
export interface KillSandboxOpts {
  /**
   * Signal name, such as `"SIGKILL"`. Accepted but currently ignored: every
   * kill is a hard cancel regardless of the signal you pass.
   */
  signal?: string
}

/** Options for {@link Sandbox.create}. */
export interface CreateSandboxOpts {
  /** An optional name for the sandbox, unique within your organization. */
  name?: string
  /** The resources to request. The server fills in defaults for anything you leave unset. */
  resources?: Resources
  /** The runtime to use. Set exactly one of `named` or `imageRef`. */
  runtime?: Runtime
  /**
   * Environment variables for the sandbox. The server merges these into every
   * command run on the sandbox. When a command sets the same variable, the
   * command's value wins.
   */
  env?: Record<string, string>
  /**
   * Place the sandbox on a non-production compute pool. This is an unstable
   * option for Depot-supported testing and may be removed without notice.
   * Leave unset for normal placement.
   */
  staging?: boolean
  /**
   * Requested lifetime in minutes, measured from when the sandbox is created —
   * provisioning time counts against it. Must be a positive integer. The
   * server caps larger values at the maximum (24 hours); omit it to use the
   * server default (2 hours).
   */
  timeoutMinutes?: number
  /** Keep the sandbox off your organization's tailnet, which it otherwise joins when Tailscale is connected. */
  disableTailnet?: boolean
  /** Configuration for every command, including the org CI secrets to inject. */
  configuration?: SandboxConfiguration
  /** CPU architecture to run on. Defaults to `amd64`. A custom `runtime` image without a matching variant fails at boot. */
  architecture?: Architecture
}

/** Options for {@link Sandbox.setTimeout}. */
export interface SetTimeoutOpts {
  /**
   * New timeout in minutes, measured from when the server handles the request.
   * Must be a positive integer. The server caps larger values at the sandbox's
   * absolute maximum lifetime.
   */
  timeoutMinutes: number
}

/** Options for {@link Sandbox.list}. */
export interface ListSandboxesOpts {
  pagination?: Pagination
  filter?: ListFilter
}

/** Options for {@link Sandbox.listAll}. */
export interface ListAllSandboxesOpts {
  pageSize?: number
  filter?: ListFilter
}

/** Result of {@link Sandbox.list}. */
export interface ListSandboxesResult {
  sandboxes: Sandbox[]
  pagination: PaginationResult
}

/**
 * Reject invalid timeout values before any RPC is issued, including values the
 * protobuf int32 field cannot represent.
 */
function assertTimeoutMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 2_147_483_647) {
    throw new TypeError(`timeoutMinutes must be a positive safe int32 integer, got ${minutes}`)
  }
}

function configurationToProto(configuration: SandboxConfiguration): SandboxConfigurationProto {
  return create(SandboxConfigurationSchema, {
    secrets: Object.entries(configuration.secrets).map(([env, secret]) => ({env, secret})),
    environment: configuration.environment,
    repository: configuration.repository,
  })
}

function assertNoLegacyTimeoutMs(opts: object): void {
  if (Object.prototype.hasOwnProperty.call(opts, 'timeoutMs')) {
    throw new TypeError('timeoutMs was replaced by timeoutMinutes')
  }
}

function runtimeToProto(runtime: Runtime): RuntimeProto {
  if ('named' in runtime) {
    return create(RuntimeSchema, {runtime: {case: 'named', value: runtime.named}})
  }
  return create(RuntimeSchema, {runtime: {case: 'imageRef', value: runtime.imageRef}})
}

function architectureToProto(architecture: Architecture): ArchitectureProto {
  const value = ArchitectureProto[architecture.toUpperCase() as keyof typeof ArchitectureProto]
  // Only reachable when a caller forces an invalid value through a cast.
  if (value === undefined) {
    throw new TypeError(`unknown Architecture: ${architecture}`)
  }
  return value
}

// Like sandboxStatusFromProto: UNSPECIFIED and values newer than this build map to undefined.
function architectureFromProto(architecture: ArchitectureProto): Architecture | undefined {
  if (architecture === ArchitectureProto.UNSPECIFIED) return undefined
  const name = ArchitectureProto[architecture]
  return name === undefined ? undefined : (name.toLowerCase() as Architecture)
}

function resourcesFromProto(sandbox: SandboxProto): Resources | undefined {
  const r = sandbox.resources
  if (!r) return undefined
  return {vcpus: r.vcpus, memoryMb: r.memoryMb, diskGb: r.diskGb}
}

function runtimeFromProto(sandbox: SandboxProto): Runtime | undefined {
  const r = sandbox.runtime?.runtime
  if (!r || r.case === undefined) return undefined
  if (r.case === 'named') return {named: r.value}
  return {imageRef: r.value}
}

function timestampToDate(ts: Timestamp | undefined): Date | undefined {
  return ts ? timestampDate(ts) : undefined
}

// int64 proto fields arrive as bigint, but the SDK exposes them as plain
// numbers because that's easier to work with. The timeout and metering values
// we deal with stay well within Number.MAX_SAFE_INTEGER, so the conversion is
// safe in practice. Values above 2^53 would lose precision.
function bigintToNumber(value: bigint | undefined): number | undefined {
  return value !== undefined ? Number(value) : undefined
}

async function drainStream(
  command: SandboxCommandExecution,
  iterator: AsyncIterator<SandboxCommandExecutionEvent>,
): Promise<void> {
  let sawFinished = false
  try {
    while (true) {
      const r = await iterator.next()
      if (r.done) break
      _commandInternals.ingest(command, r.value)
      if (r.value.event.case === 'finished') {
        sawFinished = true
        break
      }
    }
    if (sawFinished) {
      _commandInternals.end(command)
    } else {
      // Server stream ended without a Finished event. The handler's
      // no-exit-code path records the row as failed and then returns
      // normally, so end()'ing here would leave the SDK object with
      // status 'running' and output()/wait() resolving as if the
      // command succeeded. Surface as a failure so callers see the
      // discrepancy.
      _commandInternals.failClosedWithoutFinished(command)
    }
  } catch (err) {
    _commandInternals.fail(command, err)
  } finally {
    // We obtained `iterator` by calling stream[Symbol.asyncIterator]()
    // and manually drove it with .next(), so a regular for-await-of's
    // implicit cleanup doesn't apply. If we broke out of the loop on
    // 'finished' (or `_commandInternals.fail` raised), the underlying
    // HTTP/2 stream stays open until GC reclaims the iterator. Signal
    // explicitly so the transport can release it now. .return() is
    // optional on AsyncIterator; guard for that and swallow errors so
    // a misbehaving iterator doesn't shadow whatever we already
    // recorded above.
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return()
      } catch {
        // ignore — best-effort cleanup
      }
    }
  }
}

function networkUsageFromProto(usage: NetworkUsageProto | undefined): NetworkUsage | undefined {
  if (!usage) return undefined
  return {ingressBytes: Number(usage.ingressBytes), egressBytes: Number(usage.egressBytes)}
}

// The SDK's status strings are just the lowercased proto enum names, so we can
// convert by looking up the enum's name for a given numeric value.
function sandboxStatusFromProto(status: SandboxStatusProto): SandboxStatus | undefined {
  if (status === SandboxStatusProto.UNSPECIFIED) return undefined
  // A newer server can send a status this SDK build doesn't know about, which
  // arrives as a raw number with no matching enum name. Return undefined for
  // those rather than throwing, so an older SDK can still read every other
  // field on the sandbox.
  const name = SandboxStatusProto[status]
  return name === undefined ? undefined : (name.toLowerCase() as SandboxStatus)
}

function sandboxStatusToProto(status: SandboxStatus): SandboxStatusProto {
  const value = SandboxStatusProto[status.toUpperCase() as keyof typeof SandboxStatusProto]
  // The status union should always line up with the generated enum, so this
  // can only happen if the two have drifted apart, or a caller forced an
  // invalid value through a cast. Fail with a clear error instead of sending
  // garbage to the server.
  if (value === undefined) {
    throw new Error(`unknown SandboxStatus: ${status}`)
  }
  return value
}

function filterToProto(filter: ListFilter): ListSandboxesFilterProto {
  return create(ListSandboxesRequest_FilterSchema, {
    states: (filter.states ?? []).map(sandboxStatusToProto),
    createdAfter: filter.createdAfter !== undefined ? timestampFromDate(filter.createdAfter) : undefined,
    createdBefore: filter.createdBefore !== undefined ? timestampFromDate(filter.createdBefore) : undefined,
  })
}

function commandLogEncoding(encoding: BufferEncoding | 'buffer' = 'utf8') {
  if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) throw new TypeError(`Unknown log encoding: ${encoding}`)
  return encoding
}

function commandLogEntry(
  entry: LogEntryProto,
  encoding: BufferEncoding | 'buffer',
): SandboxCommandLogEntry<string | Uint8Array> {
  if (entry.stream !== 'stdout' && entry.stream !== 'stderr') {
    throw new ConnectError('Unknown command log channel', Code.DataLoss)
  }
  if (!entry.timestamp) throw new ConnectError('Command log timestamp is missing', Code.DataLoss)
  return {
    data: encoding === 'buffer' ? entry.data : Buffer.from(entry.data).toString(encoding),
    stream: entry.stream,
    timestamp: timestampDate(entry.timestamp),
    lineNumber: entry.lineNumber,
  }
}
