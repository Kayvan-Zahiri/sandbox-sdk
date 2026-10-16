import assert from 'node:assert'
import test from 'node:test'
import {createClient} from './client.js'
import {Sandbox} from './sandbox.js'

// Runs against a real API only when DEPOT_SANDBOX_LIVE_TOKEN is set, so `pnpm test` stays hermetic.
const token = process.env.DEPOT_SANDBOX_LIVE_TOKEN

test('snapshot round trip restores a written file', {skip: !token, timeout: 10 * 60_000}, async () => {
  const client = createClient({
    token: token!,
    orgID: process.env.DEPOT_ORG_ID,
    endpoint: process.env.DEPOT_SANDBOX_LIVE_ENDPOINT,
  })
  const source = await Sandbox.create(client, {name: 'sdk-snapshot-live-source', timeoutMinutes: 15})
  let restored: Sandbox | undefined
  try {
    const home = await (await source.runCommand({cmd: 'sh', args: ['-c', 'printf %s "$HOME"']})).stdout()
    const path = `${home}/snapshot-check.txt`
    await source.fs().writeFile(path, 'round trip')
    const snapshot = await source.snapshot()
    assert.equal(snapshot.sourceSandboxId, source.sandboxId)

    restored = await Sandbox.create(client, {snapshot, timeoutMinutes: 15})
    assert.equal(restored.architecture, snapshot.architecture)
    assert.equal(await restored.fs().readFile(path, {encoding: 'utf8'}), 'round trip')
  } finally {
    await Promise.allSettled([source.kill(), restored?.kill()])
  }
})
