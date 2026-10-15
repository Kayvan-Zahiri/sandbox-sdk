// Public types for the @depot/sandbox SDK.
//
// The generated proto types in ./gen/ stay close to the wire format: numeric
// enums, camelCase derived from snake_case, and proto Timestamp messages. The
// types here are the friendlier shapes we hand to SDK users instead: string
// unions for enums, Date in place of Timestamp, and discriminated unions in
// place of proto oneofs.

/**
 * The lifecycle status of a sandbox, as a string instead of the wire enum.
 *
 * The underlying proto enum includes an `UNSPECIFIED` zero value that the
 * server never actually returns. Rather than expose it here, the conversion
 * helper `sandboxStatusFromProto` maps that case to `undefined`.
 */
export type SandboxStatus = 'created' | 'assigned' | 'starting' | 'running' | 'finished' | 'cancelled' | 'failed'

/** The CPU architecture a sandbox runs on, as a string instead of the wire enum. */
export type Architecture = 'amd64' | 'arm64'

/**
 * Bytes transferred over the sandbox's primary network interface. This is only
 * reported once the sandbox reaches a terminal status, and only when a metering
 * source is available server-side; it is `undefined` otherwise.
 */
export interface NetworkUsage {
  ingressBytes: number
  egressBytes: number
}

/** Configuration applied to every command run in a sandbox for its whole life. */
export interface SandboxConfiguration {
  /**
   * Org CI secrets to inject, keyed by environment variable name; each value
   * names a CI secret, e.g. `{DATABASE_URL: 'PROD_DATABASE_URL'}`. Wins over
   * an `env` entry with the same name.
   *
   * An invalid variable name or an unknown or inapplicable secret fails create
   * with InvalidArgument; a secret deleted after create fails each command with
   * FailedPrecondition (create a new sandbox). Command output is not masked.
   */
  secrets: Record<string, string>
  /**
   * CI environment that picks each secret's variant; unset uses unscoped variants. Requires an owner or org token,
   * which `runCommand` and `fs()` on the sandbox then require too.
   */
  environment?: string
  /**
   * Repository that picks each secret's variant; unset uses unscoped variants. Requires an owner or org token,
   * which `runCommand` and `fs()` on the sandbox then require too.
   */
  repository?: string
}

/**
 * The compute resources to request for a sandbox. Every field is optional;
 * leaving one unset lets the server choose a default.
 */
export interface Resources {
  vcpus?: number
  memoryMb?: number
  diskGb?: number
}

/**
 * Selects which runtime a sandbox boots into. Today the only supported option
 * is `imageRef`, an arbitrary OCI image reference.
 *
 * The `named` variant is reserved for a future catalog of curated runtimes
 * (for example `"node24"`) that the server would resolve by name. It is not
 * usable yet: the server currently rejects any `named` value, so do not set it
 * until the catalog ships.
 */
export type Runtime = {readonly named: string} | {readonly imageRef: string}

/** Narrows the results of {@link Sandbox.list} and {@link Sandbox.listAll}. */
export interface ListFilter {
  /** When set, only return sandboxes whose status is one of these values. */
  states?: readonly SandboxStatus[]
  /** Only return sandboxes created after this time. The bound is exclusive. */
  createdAfter?: Date
  /** Only return sandboxes created before this time. The bound is exclusive. */
  createdBefore?: Date
}

/** Controls how a list request is paginated. */
export interface Pagination {
  /** How many results to return per page. The server caps this, and picks a default when it is unset. */
  pageSize?: number
  /** An opaque cursor from a previous call's `nextPageToken`, used to fetch the next page. */
  pageToken?: string
}

/** The pagination details returned alongside a page of results. `nextPageToken` is undefined on the last page. */
export interface PaginationResult {
  nextPageToken?: string
}

/**
 * Friendly SDK alias of the generated `SandboxCommandExecutionStatus` proto enum.
 *
 * The proto enum carries a sentinel `UNSPECIFIED` zero value that the server
 * never returns; that case is mapped to `undefined` at the SDK boundary
 * rather than leaking into the union.
 */
export type SandboxCommandExecutionStatus = 'pending' | 'running' | 'finished' | 'failed' | 'killed'

/**
 * Options bag for {@link Sandbox.runCommand}.
 *
 * `detached` returns after launch. Use sandbox.readLogs() or sandbox.streamLogs()
 * to retrieve retained output. The execution object's logs(), output(), and wait()
 * remain unavailable for detached commands.
 */
export interface RunCommandOpts {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  sudo?: boolean
  detached?: boolean
}

/** A retained line record. Capture removes line delimiters; data may contain non-UTF-8 bytes. */
export interface SandboxCommandLogEntry {
  data: Uint8Array
  stream: 'stdout' | 'stderr'
  timestamp: Date
  lineNumber?: bigint
}

/** A snapshot of retained output. Completion and truncation are independent. */
export interface SandboxCommandLogs {
  entries: SandboxCommandLogEntry[]
  complete: boolean
  truncated: boolean
}

/** A batch of retained or newly captured records, including silent completion. */
export interface SandboxCommandLogBatch {
  entries: SandboxCommandLogEntry[]
  complete: boolean
}

export interface ReadLogsOpts {
  /** Maximum records to return. Default: 1000. Maximum: 10000. */
  limit?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface StreamLogsOpts {
  signal?: AbortSignal
  /** Maximum time to follow output. The API also bounds streams to four minutes. */
  timeoutMs?: number
}
