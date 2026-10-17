import type {SandboxCommandExecution} from './command.js'
import type {RunCommandOpts} from './types.js'

/** tailscaled's `BackendState`, or `NotInstalled` (no `tailscale` binary) / `NotRunning` (daemon unreachable). */
export type TailnetBackendState =
  | 'NotInstalled'
  | 'NotRunning'
  | 'NoState'
  | 'NeedsLogin'
  | 'NeedsMachineAuth'
  | 'Stopped'
  | 'Starting'
  | 'Running'
  | (string & {})

/** A snapshot of the sandbox's tailnet connection, from `tailscale status --json`. */
export interface TailnetStatus {
  backendState: TailnetBackendState
  /** IPv4 first; empty until the node has joined. */
  ips: string[]
  /** The node's fully qualified MagicDNS name as the tailnet assigned it, without the trailing dot. */
  dnsName: string | undefined
}

/** Options for {@link SandboxTailnet.waitForAddress}. */
export interface WaitForAddressOpts {
  /** Default 60 seconds. */
  timeoutMs?: number
  /** Pause between status checks. Default 1 second. */
  intervalMs?: number
}

/** Thrown by {@link SandboxTailnet.waitForAddress} when the node doesn't come up in time. */
export class TailnetTimeoutError extends Error {
  override readonly name = 'TailnetTimeoutError'
  /** Undefined when no status check finished before the deadline. */
  constructor(readonly lastStatus: TailnetStatus | undefined) {
    super(
      `sandbox did not get a tailnet address in time (last backend state: ${lastStatus?.backendState ?? 'unknown'})`,
    )
  }
}

const NOT_INSTALLED_EXIT_CODE = 127
const STATUS_SCRIPT = `command -v tailscale >/dev/null 2>&1 || exit ${NOT_INSTALLED_EXIT_CODE}; exec tailscale status --json`

/**
 * The sandbox's connection to its organization's tailnet. The join runs in the
 * background while the sandbox boots, so call {@link waitForAddress} first.
 */
export class SandboxTailnet {
  protected readonly run: (opts: RunCommandOpts) => Promise<SandboxCommandExecution>

  /** @internal */
  constructor(opts: {run: (opts: RunCommandOpts) => Promise<SandboxCommandExecution>}) {
    this.run = opts.run
  }

  /** Runs `tailscale status --json` in the sandbox. */
  async status(): Promise<TailnetStatus> {
    const command = await this.run({cmd: '/bin/sh', args: ['-c', STATUS_SCRIPT]})
    const stdout = await command.stdout()
    const {exitCode} = await command.wait()
    if (exitCode === NOT_INSTALLED_EXIT_CODE) return {backendState: 'NotInstalled', ips: [], dnsName: undefined}
    if (exitCode !== 0) return {backendState: 'NotRunning', ips: [], dnsName: undefined}
    return parseTailscaleStatus(stdout)
  }

  /**
   * Polls {@link status} until the node is `Running` with an IP, and resolves to that
   * status: its `dnsName` and `ips` are how to reach the sandbox. Throws at once
   * without a `tailscale` binary, and {@link TailnetTimeoutError} on timeout.
   */
  async waitForAddress(opts: WaitForAddressOpts = {}): Promise<TailnetStatus> {
    const timeoutMs = opts.timeoutMs ?? 60_000
    const intervalMs = opts.intervalMs ?? 1_000
    for (const [name, value] of [
      ['timeoutMs', timeoutMs],
      ['intervalMs', intervalMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite, non-negative number`)
    }
    const deadline = Date.now() + timeoutMs
    let last: TailnetStatus | undefined
    while (true) {
      const status = await beforeDeadline(this.status(), deadline, () => new TailnetTimeoutError(last))
      last = status
      if (status.backendState === 'Running' && status.ips.length > 0) return status
      if (status.backendState === 'NotInstalled') {
        throw new Error('tailscale is not installed in this sandbox image, so it cannot join the tailnet')
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new TailnetTimeoutError(status)
      // Timers can fire before Date.now() reaches their due time, so trust a sleep to the deadline.
      const sleepMs = Math.min(intervalMs, remaining)
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
      if (sleepMs === remaining || Date.now() >= deadline) throw new TailnetTimeoutError(status)
    }
  }
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // A check still running at the deadline is abandoned; its late failure is moot.
  promise.catch(() => {})
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), Math.max(0, deadline - Date.now()))
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** @internal Exported for tests. */
export function parseTailscaleStatus(json: string): TailnetStatus {
  const raw = JSON.parse(json) as {BackendState?: unknown; TailscaleIPs?: unknown; Self?: {DNSName?: unknown}}
  const ips = Array.isArray(raw.TailscaleIPs) ? raw.TailscaleIPs.filter((ip) => typeof ip === 'string') : []
  const dnsName = typeof raw.Self?.DNSName === 'string' ? raw.Self.DNSName.replace(/\.$/, '') : ''
  return {
    backendState: typeof raw.BackendState === 'string' ? raw.BackendState : 'NoState',
    ips: [...ips].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':'))),
    dnsName: dnsName || undefined,
  }
}
