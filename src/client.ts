import {createClient as createConnectClient, type Client} from '@connectrpc/connect'
import {createConnectTransport, Http2SessionManager} from '@connectrpc/connect-node'
import {AsyncLocalStorage} from 'node:async_hooks'
import type {ClientHttp2Stream} from 'node:http2'
import {SandboxService} from './gen/depot/sandbox/v1/sandbox_pb.js'

/** Default Connect endpoint for the v1 sandbox API. */
export const DEFAULT_ENDPOINT = 'https://api.depot.dev'

/**
 * Creates a `SandboxClient`. The returned value is an opaque handle that wraps
 * the underlying Connect client; pass it to static Sandbox entry points.
 *
 * ```ts
 * const client = createClient({token: process.env.DEPOT_TOKEN!})
 * const sandbox = await Sandbox.create(client)
 * ```
 */
export function createClient(opts: CreateClientOpts): SandboxClient {
  if (!opts?.token) {
    throw new Error('createClient requires a token')
  }
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
  const transport = createConnectTransport({
    baseUrl: endpoint,
    httpVersion: '2',
    sessionManager: new ReleasingSessionManager(endpoint),
    interceptors: [
      (next) => (req) => {
        applyAuthHeaders(req, opts)
        return callSignal.run(req.signal, () => next(req))
      },
    ],
  })
  return {
    rpc: createConnectClient(SandboxService, transport),
    endpoint,
  }
}

const callSignal = new AsyncLocalStorage<AbortSignal>()

// A canceled call leaves its stream open when the server already ended it:
// connect-node skips close() on a closed stream, and Node keeps one open until
// its response is read. The open stream holds the connection, so the process
// never exits. Destroy it once its call is aborted (DEP-7687).
class ReleasingSessionManager extends Http2SessionManager {
  override async request(...args: Parameters<Http2SessionManager['request']>): Promise<ClientHttp2Stream> {
    const signal = callSignal.getStore()
    const stream = await super.request(...args)
    if (signal) {
      const release = () => stream.destroy()
      if (signal.aborted) release()
      signal.addEventListener('abort', release, {once: true})
      stream.once('close', () => signal.removeEventListener('abort', release))
    }
    return stream
  }
}

export interface CreateClientOpts {
  /** Bearer token used to authenticate requests, typically your `DEPOT_TOKEN`. */
  token: string
  /** API endpoint to connect to. Defaults to {@link DEFAULT_ENDPOINT}. */
  endpoint?: string
  /**
   * Organization the client should act on. This is required for app and
   * service tokens, and for user tokens that belong to more than one
   * organization. For a user token bound to a single organization it is
   * ignored, since that organization is already implied. This corresponds to
   * the `--org` flag on the `depot` CLI.
   */
  orgID?: string
}

interface HeaderCarrier {
  header: {
    set(name: string, value: string): void
  }
}

/** @internal Apply Depot auth headers for tests and the Connect interceptor. */
export function applyAuthHeaders(req: HeaderCarrier, opts: CreateClientOpts): void {
  req.header.set('Authorization', `Bearer ${opts.token}`)
  // App and service tokens, along with user tokens that belong to more than
  // one organization, need the `x-depot-org` header so the server knows which
  // organization to act on. Without it, those requests are rejected with
  // PermissionDenied. A user token bound to a single organization works with or
  // without the header.
  if (opts.orgID) {
    req.header.set('x-depot-org', opts.orgID)
  }
}

/** Opaque client wrapping a Connect `Client<typeof SandboxService>`. */
export interface SandboxClient {
  readonly rpc: Client<typeof SandboxService>
  readonly endpoint: string
}
