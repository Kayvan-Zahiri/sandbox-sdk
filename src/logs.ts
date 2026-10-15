import {timestampDate, timestampFromDate} from '@bufbuild/protobuf/wkt'
import {Code, ConnectError} from '@connectrpc/connect'
import type {SandboxClient} from './client.js'
import type {SandboxLogEntry} from './gen/depot/sandbox/v1/logs_pb.js'

export type LogSource = 'stdout' | 'stderr' | 'system' | 'unknown'

/** A retained record. Capture removes line delimiters; messages are UTF-8 text. */
export interface LogEntry {
  readonly message: string
  readonly source: LogSource
  readonly timestamp: Date
  readonly objectId: string
  readonly contextIds: string[]
}
export interface SandboxLogFetchParams {
  since: Date
  until?: Date
  source?: LogSource
  /** Case-sensitive text contained in the message. */
  searchText?: string
}
export interface SandboxLogTailParams {
  /** Number of latest records. Default: 100. Maximum: 20000. */
  entries?: number
  source?: LogSource
}

/** Query retained sandbox logs independently of process output streams. */
export class SandboxLogs {
  /** @internal */
  constructor(
    private readonly client: SandboxClient,
    private readonly sandboxId: string,
  ) {}

  /** Fetch available records in [since, until), in chronological order. Does not follow new logs. */
  async *fetch(params: SandboxLogFetchParams): AsyncIterable<LogEntry> {
    const until = params.until ?? new Date()
    if (
      !(params.since instanceof Date) ||
      !Number.isFinite(params.since.getTime()) ||
      !Number.isFinite(until.getTime()) ||
      params.since >= until
    ) {
      throw new TypeError('since must be a valid Date before until')
    }
    const controller = new AbortController()
    try {
      for await (const entry of this.client.rpc.fetchSandboxLogs(
        {
          sandbox: {selector: {case: 'id', value: this.sandboxId}},
          since: timestampFromDate(params.since),
          until: timestampFromDate(until),
          source: params.source,
          searchText: params.searchText,
        },
        {signal: controller.signal},
      ))
        yield logEntry(entry)
    } finally {
      controller.abort()
    }
  }

  /** Fetch the latest N available records in chronological order, then finish. */
  async *tail(params: SandboxLogTailParams = {}): AsyncIterable<LogEntry> {
    const controller = new AbortController()
    try {
      for await (const entry of this.client.rpc.tailSandboxLogs(
        {
          sandbox: {selector: {case: 'id', value: this.sandboxId}},
          entries: params.entries,
          source: params.source,
        },
        {signal: controller.signal},
      ))
        yield logEntry(entry)
    } finally {
      controller.abort()
    }
  }
}

function logEntry(entry: SandboxLogEntry): LogEntry {
  if (!entry.timestamp || !['stdout', 'stderr', 'system', 'unknown'].includes(entry.source)) {
    throw new ConnectError('Invalid sandbox log record', Code.DataLoss)
  }
  return {
    message: entry.message,
    source: entry.source as LogSource,
    timestamp: timestampDate(entry.timestamp),
    objectId: entry.objectId,
    contextIds: [...entry.contextIds],
  }
}
