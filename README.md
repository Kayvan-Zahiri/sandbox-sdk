# @depot/sandbox

Beta TypeScript SDK for Depot sandboxes.

This package wraps the `depot.sandbox.v1` API with Vercel-shaped classes for creating sandboxes, running commands, streaming command output, and using a `node:fs/promises`-shaped filesystem interface.

## Installation

After the beta package is published:

```bash
pnpm add @depot/sandbox
```

## Usage

Set `DEPOT_TOKEN` in your environment, then create a client and pass it to the static sandbox entry points. Returned sandbox instances keep that client, so instance methods do not take a client argument.

```typescript
import {createClient, Sandbox} from '@depot/sandbox'

const client = createClient({token: process.env.DEPOT_TOKEN!})
const sandbox = await Sandbox.create(client, {
  env: {NODE_ENV: 'development'},
})

const command = await sandbox.runCommand({cmd: 'echo', args: ['hello from depot']})
const finished = await command.wait()

console.log(finished.exitCode)
console.log(await command.stdout())

const fs = sandbox.fs()
await fs.writeFile('/tmp/message.txt', 'hello')
console.log(await fs.readFile('/tmp/message.txt', {encoding: 'utf8'}))

await sandbox.setTimeout({timeoutMinutes: 240})
await sandbox.stop({blocking: true})
```

You can also pass token, organization, and endpoint options explicitly:

```typescript
const client = createClient({
  token: process.env.DEPOT_TOKEN!,
  orgID: process.env.DEPOT_ORG_ID,
})
```

### CI secrets

Pass `configuration.secrets` to expose your organization's CI secrets to every command in the sandbox. Each key is the environment variable to set, and each value is the name of a CI secret. `environment` and `repository` choose which variant of each secret applies, the same way a CI workflow would.

```typescript
const sandbox = await Sandbox.create(client, {
  configuration: {
    secrets: {DATABASE_URL: 'PROD_DATABASE_URL'},
    environment: 'production',
    repository: 'acme/app',
  },
})

await sandbox.runCommand({cmd: 'sh', args: ['-c', 'psql "$DATABASE_URL" -c "select 1"']})
```

- **Unknown or inapplicable name:** `Sandbox.create` fails with `InvalidArgument` when a secret doesn't exist, or has no variant for the given `environment` and `repository`.
- **Scoped variants:** setting `environment` or `repository` requires an organization owner or an organization token; otherwise `Sandbox.create` fails with `PermissionDenied`. The same applies to `runCommand` and file system calls on that sandbox.
- **Deleted secret:** each command reads the secret's current value when it starts, so a rotated value applies to the next command. If the secret was deleted after the sandbox was created, the command fails with `FailedPrecondition`. Create a new sandbox to recover.
- **Output is not masked:** a command that prints the variable streams its value back to you.

### Architecture

Sandboxes run on `amd64` unless you ask for `arm64`. Without a `runtime`, an `arm64` sandbox boots Depot's arm64 base image. `sandbox.architecture` reports the architecture the sandbox runs on.

```typescript
const sandbox = await Sandbox.create(client, {architecture: 'arm64'})

console.log(sandbox.architecture) // 'arm64'
```

A custom `runtime.imageRef` must be hosted on `registry.depot.dev` on either architecture; any other registry fails create with `InvalidArgument`. For `arm64`, the image must also publish a `linux/arm64` variant. If it doesn't, create succeeds but the sandbox ends in the `failed` status when it boots.

### Snapshots

`sandbox.snapshot()` captures a running sandbox's home directory (`/home/runner` on the default image), plus `/workspace` when it exists and is writable, into a snapshot. Pass the snapshot, or its `snapshotId`, to `Sandbox.create` to boot a new sandbox with those files restored before it starts running.

```typescript
await sandbox.fs().writeFile('/home/runner/notes.txt', 'hello')
const snapshot = await sandbox.snapshot()

const copy = await Sandbox.create(client, {snapshot})
console.log(await copy.fs().readFile('/home/runner/notes.txt', {encoding: 'utf8'}))
```

Caches, the default image's toolchains (such as `.nvm` and `.rustup`), and rebuildable `/workspace` directories (such as `node_modules` and `.venv`) are left out, so reinstall dependencies in the copy. See the [SDK reference](https://depot.dev/docs/api/sandbox-sdk-reference#snapshot-a-sandbox) for the full list.

The new sandbox uses the snapshot's runtime and architecture unless you set `runtime` yourself. Setting an `architecture` that differs from the snapshot's fails create with `InvalidArgument`.

## Beta Surface

This beta package currently includes:

- `createClient`
- `Sandbox.create` (including CI secrets, `architecture`, and `snapshot`), `Sandbox.get`, `Sandbox.list`, `Sandbox.listAll`
- `sandbox.stop`, `sandbox.kill`, `sandbox.setTimeout`, `sandbox.runCommand`, `sandbox.fs`, `sandbox.snapshot`
- `SandboxCommandExecution.wait`, `logs`, `output`, `stdout`, and `stderr`
- `FileSystem` helpers for common file operations
- `sandbox.tailnet`: `status()` and `waitForAddress()`, which report the sandbox's live MagicDNS name and IPs on your organization's tailnet; opt out with `disableTailnet` on create
- Depot Cache: every command gets your organization's Depot Cache credentials for sccache, Turborepo, and Nx, plus `DEPOT_CACHE_HOST` and `DEPOT_CACHE_TOKEN` for other tools; opt out with `disableDepotCache` on create

Other sandbox capabilities, such as piped stdin, command history, and pty support, are not part of this beta surface yet.

## Generated Protos

In this repository, the `depot.sandbox.v1` proto sources are vendored in `proto/`, and the generated TypeScript files are checked in under `src/gen`. The published package ships the compiled generated bindings so customers do not need a separate proto module.

After changing a proto, regenerate the TypeScript bindings:

```bash
pnpm run gen
```

CI runs `pnpm run gen:check` through `pnpm run validate` to catch drift between `proto/` and `src/gen`.

## Releasing

Releases are published from GitHub releases through npm trusted publishing. No npm token is required for the normal publish workflow.

To publish a new version:

1. Update `package.json` to the next version or semver channel.
2. Merge the change to `main`.
3. Review the draft release generated by release-drafter and edit the release notes.
4. Publish the GitHub release with label **None** and tag `v<release-version>`.

Release Drafter starts from the committed `package.json` version. If that version is already represented by an unreleased draft, it keeps updating the draft. If that version is already published or tagged, it advances to the next numeric prerelease version in the same semver channel, such as `0.1.0-beta.1` to `0.1.0-beta.2`. To switch channels, merge a `package.json` version that selects the new channel, such as `0.1.0-alpha.1`, `0.1.0-rc.1`, or `0.1.0`.

Semver prerelease identifiers are package version channels only. They do not make the GitHub release a pre-release, and every npm publish updates the `latest` dist-tag.

The `release.yml` workflow sets `package.json` from the GitHub release tag, validates the package, and publishes the new `@depot/sandbox` version to npm as `latest`.

npm trusted publishing must be configured for the `depot/sandbox-sdk` repository and `.github/workflows/release.yml` workflow. The first CI publish from this repo should update npm registry metadata that still points at the earlier manual `sdk-node` publish.

If a GitHub release is published but the npm publish workflow fails before the package version reaches npm, the release tag is consumed but there is no npm package version to repair. First rerun the failed release workflow from GitHub Actions. If rerunning cannot recover it, delete the GitHub release and tag, then let Release Drafter create a new draft from the next `main` run.

If a published version has incorrect release metadata or npm dist-tags, prefer fixing forward by bumping `package.json` to the next version and publishing a new release. Avoid adding one-off metadata repair automation to the repo.

## License

MIT License, see `LICENSE`.

## Sandbox logs

Use `sandbox.logs.fetch()`, `.tail()`, and `.stream()` for captured output,
including detached commands. These replace the earlier `sandbox.readLogs()` and
`sandbox.streamLogs()` methods and their option/result types. Retained records
are UTF-8 text; the API does not expose command completion, truncation flags,
raw-byte encoding options, or automatic read retries. Empty results do not prove
that ingestion is complete.

To select one command's output, pass the command object or its ID to `fetch()`:

```ts
const since = new Date()
const command = await sandbox.runCommand({cmd: 'echo', args: ['hello'], detached: true})

for await (const entry of sandbox.logs.fetch({since, command, group: 'root'})) {
  console.log(entry.message)
}
```

Capture and export are asynchronous, so an immediate query can be empty.
Execution-object `logs()`, `output()`, and `wait()` keep their attached-command
semantics and remain unavailable for detached commands. Attached output APIs
provide the exact process bytes; captured records remove line delimiters.

### Query retained sandbox logs

Use `sandbox.logs` to query captured records separately from command output
streams. Both methods yield decoded UTF-8 messages with `source`, `timestamp`,
`objectId` (the sandbox ID), and `contextIds` (the command ID when present).

```ts
for await (const entry of sandbox.logs.fetch({
  since: new Date(Date.now() - 60_000),
  source: 'stderr',
  searchText: 'error',
})) {
  console.log(entry.message)
}

for await (const entry of sandbox.logs.tail({entries: 20})) {
  console.log(`${entry.source}: ${entry.message}`)
}
```

`fetch()` queries `[since, until)` in chronological order. `until` defaults to
the current time. Source can be `stdout`, `stderr`, `unknown`, or `system`; omitted source
includes all permitted sources. `unknown` represents unspecified customer output.
System records are staff-only and are never returned by these customer methods,
even when `system` is requested as a filter. `searchText` is a case-sensitive substring. `command` selects one executed command (object or ID); `group` selects a display group (`"root"` today);
Omit either filter to include all matching commands or groups. These filters combine with the time range and source.
The maximum query range is 35 days; oversized queries fail with
`RESOURCE_EXHAUSTED` rather than silently omit records.

`tail()` returns the latest records in chronological order and finishes; it does
not follow new logs. It defaults to 100 records, accepts 0 through 10,000, and
searches up to 30 days subject to retention. It accepts `source`, `command`, and `group` filters.

`stream()` follows live arrivals across commands. It also accepts `command` and `group`; a command-filtered stream finishes at that command’s EOF. It yields the same `LogEntry`
shape as `fetch()` and `tail()`. Replay is explicit:

```ts
sandbox.logs.stream() // New arrivals only; same as {replay: 'none'}
sandbox.logs.stream({replay: 'all'}) // Everything still in Tail, then live
sandbox.logs.stream({replay: new Date(Date.now() - 60_000)}) // From a capture timestamp, then live

const controller = new AbortController()
for await (const entry of sandbox.logs.stream({replay: 'all', signal: controller.signal})) {
  console.log(`${entry.source}: ${entry.message}`)
  // Break the loop or call controller.abort() to stop.
}
```

`'all'` covers only Tail's retained replay window, which may be shorter than the
sandbox's lifetime. A timestamp is inclusive and filters both replay and future
arrivals by capture time. `'none'` skips records already in Tail when it accepts
the subscription, without relying on guest clocks. Records follow arrival order;
timestamps can arrive out of order. `source` filters output, as with `tail()`.

Command completion leaves the sandbox stream open. Calls last at most four
minutes and then fail with `DEADLINE_EXCEEDED`. A reset or unexpected closure
returns `UNAVAILABLE`; there is no automatic reconnect or durable catch-up.
Starting another stream can repeat records when replay is enabled.

Log timestamps have millisecond precision and round down. Reusing a returned
entry's timestamp as an inclusive replay cutoff includes that boundary record;
it may also repeat other records captured within the same millisecond.

Queries include captured command logs while commands are running. Recent
records can come from Tail storage, while older records become available after
durable indexing. An empty result does not establish ingestion completion;
there can be a gap between recent retention and durable availability. Capture
removes line delimiters, so retained records differ from exact process output.
