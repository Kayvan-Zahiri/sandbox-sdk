import assert from 'node:assert'
import test from 'node:test'
import type {SandboxCommandExecution} from './command.js'
import {SandboxTailnet, TailnetTimeoutError, parseTailscaleStatus} from './tailnet.js'
import type {RunCommandOpts} from './types.js'

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  TailscaleIPs: ['fd7a:115c:a1e0::1', '100.64.0.7'],
  Self: {DNSName: 'depot-sandbox-sbx1.example.ts.net.'},
})
const NEEDS_LOGIN = JSON.stringify({BackendState: 'NeedsLogin', TailscaleIPs: null, Self: {DNSName: ''}})
const STARTING = JSON.stringify({BackendState: 'Starting', TailscaleIPs: []})

type Result = {exitCode: number; stdout?: string}

function fakeTailnet(results: Result[]) {
  const requests: RunCommandOpts[] = []
  const tailnet = new SandboxTailnet({
    run: async (opts) => {
      requests.push(opts)
      const result = results[Math.min(requests.length - 1, results.length - 1)]!
      return {
        stdout: async () => result.stdout ?? '',
        wait: async () => ({exitCode: result.exitCode}),
      } as unknown as SandboxCommandExecution
    },
  })
  return {tailnet, requests}
}

test('parseTailscaleStatus reads the running state, IPv4 first, without the trailing dot', () => {
  assert.deepEqual(parseTailscaleStatus(RUNNING), {
    backendState: 'Running',
    ips: ['100.64.0.7', 'fd7a:115c:a1e0::1'],
    dnsName: 'depot-sandbox-sbx1.example.ts.net',
  })
})

test('parseTailscaleStatus tolerates the null and empty fields of a node that has not joined', () => {
  assert.deepEqual(parseTailscaleStatus(NEEDS_LOGIN), {backendState: 'NeedsLogin', ips: [], dnsName: undefined})
  assert.deepEqual(parseTailscaleStatus(STARTING), {backendState: 'Starting', ips: [], dnsName: undefined})
})

test('status runs tailscale status --json through the shell', async () => {
  const {tailnet, requests} = fakeTailnet([{exitCode: 0, stdout: RUNNING}])
  assert.equal((await tailnet.status()).backendState, 'Running')
  assert.equal(requests[0]?.cmd, '/bin/sh')
  assert.match(requests[0]?.args?.[1] ?? '', /tailscale status --json/)
})

test('status reports a missing binary and an unreachable daemon', async () => {
  assert.deepEqual(await fakeTailnet([{exitCode: 127}]).tailnet.status(), {
    backendState: 'NotInstalled',
    ips: [],
    dnsName: undefined,
  })
  assert.equal((await fakeTailnet([{exitCode: 1}]).tailnet.status()).backendState, 'NotRunning')
})

test('waitForAddress polls until the node is running with an IP', async () => {
  const {tailnet, requests} = fakeTailnet([
    {exitCode: 1},
    {exitCode: 0, stdout: STARTING},
    {exitCode: 0, stdout: RUNNING},
  ])
  const status = await tailnet.waitForAddress({intervalMs: 1})
  assert.equal(status.dnsName, 'depot-sandbox-sbx1.example.ts.net')
  assert.equal(status.ips[0], '100.64.0.7')
  assert.equal(requests.length, 3)
})

test('waitForAddress fails fast when tailscale is not installed', async () => {
  const {tailnet, requests} = fakeTailnet([{exitCode: 127}])
  await assert.rejects(tailnet.waitForAddress({intervalMs: 1}), /not installed/)
  assert.equal(requests.length, 1)
})

test('waitForAddress rejects a non-finite timeout before running anything', async () => {
  const {tailnet, requests} = fakeTailnet([{exitCode: 0, stdout: NEEDS_LOGIN}])
  await assert.rejects(tailnet.waitForAddress({timeoutMs: Number.NaN}), TypeError)
  await assert.rejects(tailnet.waitForAddress({timeoutMs: Infinity}), TypeError)
  assert.equal(requests.length, 0)
})

test('waitForAddress times out while a status check hangs', async () => {
  const tailnet = new SandboxTailnet({run: () => new Promise(() => {})})
  await assert.rejects(tailnet.waitForAddress({timeoutMs: 20}), (err) => {
    assert.ok(err instanceof TailnetTimeoutError)
    assert.equal(err.lastStatus, undefined)
    return true
  })
})

test('waitForAddress times out with the last status it saw', async () => {
  const {tailnet} = fakeTailnet([{exitCode: 0, stdout: NEEDS_LOGIN}])
  await assert.rejects(tailnet.waitForAddress({timeoutMs: 20, intervalMs: 5}), (err) => {
    assert.ok(err instanceof TailnetTimeoutError)
    assert.equal(err.lastStatus?.backendState, 'NeedsLogin')
    return true
  })
})

test('waitForAddress starts no status check once the deadline has passed', {timeout: 1_000}, async (t) => {
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const {tailnet, requests} = fakeTailnet([{exitCode: 0, stdout: NEEDS_LOGIN}])
  await assert.rejects(tailnet.waitForAddress({timeoutMs: 10, intervalMs: 50}), TailnetTimeoutError)
  assert.equal(requests.length, 1)
})

test('waitForAddress swallows a status check that fails after the timeout', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const tailnet = new SandboxTailnet({
      run: () => new Promise((_, reject) => setTimeout(() => reject(new Error('stream closed')), 30)),
    })
    await assert.rejects(tailnet.waitForAddress({timeoutMs: 10}), TailnetTimeoutError)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
