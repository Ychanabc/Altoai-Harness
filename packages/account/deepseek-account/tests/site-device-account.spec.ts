/** Website authorization through the existing account service and credential store. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { afterEach, expect, it, vi } from 'vitest'
import { DeepSeekAccount } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.unstubAllGlobals() })

it('signs in using the website device grant, exposes branding, and signs out locally', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-site-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
  const fetcher = vi.fn(async (url: URL | string, _init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path.endsWith('/bootstrap')) return reply({ api_version: 1, system_name: 'Test site', logo: '/logo.png', docs_link: '', version: 'test' })
    if (path.endsWith('/authorize')) return reply({ request_secret: 'synthetic-secret', approval_path: '/device/approve?authorization=public-id',
      expires_at: Math.floor(Date.now() / 1000) + 60, interval_seconds: 0.001 })
    if (path.endsWith('/session')) return reply({ user: { id: 7, username: 'site-user', display_name: 'Site User', email: 'user@example.test', group: 'vip' },
      token: { group: 'auto', effective_group: 'auto' }, usable_groups: { auto: {}, vip: {} }, quota: { remain: 100, used: 20 },
      quota_metadata: { quota_per_unit: 500000, quota_display_type: 'USD' } })
    if (path.endsWith('/billing')) return reply({ quota: { remain: 100, used: 20 }, subscriptions: [] })
    if (path.endsWith('/token')) return reply({ api_key: 'synthetic-api-key', user_id: 7, device_name: 'Harness' })
    throw new Error('unexpected website endpoint')
  })
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(DeepSeekAccount, { authProtocol: 'site-device', platformOrigin: 'https://site.invalid' })
  const account = ctx.deepseekAccount
  expect(await account.getState()).toMatchObject({ brand: { name: 'Test site', logo: 'https://site.invalid/logo.png' }, status: 'signed-out' })
  const controller = new AbortController()
  const updates = account.watch(controller.signal)
  const client = { version: 'test', locale: 'en', timezoneOffsetSeconds: 0 }
  await account.startSignIn(client, 'http://localhost:12345', 'desktop')
  try {
    for await (const update of updates) {
      if (update.state.status === 'credential-stored') break
      if (update.state.attempt?.phase === 'failed') throw new Error('website login failed')
    }
  } finally { controller.abort() }
  expect(await account.resolveRequestCredential('https://site.invalid/v1/chat/completions')).toMatchObject({ headers: { Authorization: 'Bearer synthetic-api-key' } })
  expect(await account.resolveRequestCredential('https://other.invalid/v1/chat/completions')).toBeUndefined()
  expect(await account.getPlatformSession()).toBeNull()
  expect(await account.getProfile(client)).toMatchObject({ status: 'ready', value: { id: '7', name: 'Site User', contact: 'user@example.test' } })
  expect(await account.getSiteSession(client)).toMatchObject({ status: 'ready', value: { group: 'vip', deviceGroup: 'auto', usableGroups: ['auto', 'vip'] } })
  expect(await account.getSiteBilling(client)).toMatchObject({ status: 'ready', value: { quota: { remain: 100 }, subscriptions: [] } })
  fetcher.mockClear()
  fetcher.mockImplementationOnce(async () => new Response('<html>404 synthetic-api-key</html>', { status: 404 }))
  fetcher.mockImplementationOnce(async () => new Response(null, { status: 404 }))
  expect(await account.getSiteSession(client)).toEqual({ status: 'endpoint-unavailable' })
  expect(await account.getSiteBilling(client)).toEqual({ status: 'endpoint-unavailable' })
  expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    '/api/client/v1/device/session', '/api/client/v1/device/billing',
  ])
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic-api-key' } })
  }
  expect(await account.getState()).toMatchObject({ status: 'credential-stored' })
  expect(await account.resolveRequestCredential('https://site.invalid/v1/models')).toMatchObject({ revoked: { aborted: false } })
  fetcher.mockImplementationOnce(async () => new Response(null, { status: 404 }))
  expect(await account.getProfile(client)).toEqual({ status: 'failed' })
  fetcher.mockImplementationOnce(async () => new Response('unavailable', { status: 503 }))
  expect(await account.getSiteBilling(client)).toEqual({ status: 'failed' })
  expect(await account.getSiteSession(client)).toMatchObject({ status: 'ready' })
  const late = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<undefined>()
  fetcher.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise })
  const pendingRead = account.getSiteSession(client)
  await entered.promise
  expect(await account.signOut(client)).toMatchObject({ status: 'signed-out' })
  late.resolve(reply({ user: { id: 999 } }))
  expect(await pendingRead).toBeNull()
  expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname.includes('logout'))).toBe(false)
})

it.each(['session', 'billing'] as const)('expires a device credential rejected by %s without retaining account data', async (field) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-site-account-expiry-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
    const path = new URL(url).pathname
    if (path.endsWith('/bootstrap')) return reply({ api_version: 1, system_name: 'Test site', logo: '', docs_link: '', version: 'test' })
    return new Response('expired', { status: 401 })
  }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(DeepSeekAccount, { authProtocol: 'site-device', platformOrigin: 'https://site.invalid' })
  await ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, token: 'synthetic-key', issuer: 'https://site.invalid', credentialType: 'site-api-key' },
  }))
  const expired = vi.fn()
  ctx.on('deepseek-account/session-expired', expired)
  const account = ctx.deepseekAccount
  const credential = await account.resolveRequestCredential('https://site.invalid/v1/models')
  const client = { version: 'test', locale: 'en', timezoneOffsetSeconds: 0 }
  expect(await (field === 'session' ? account.getSiteSession(client) : account.getSiteBilling(client))).toBeNull()
  expect(await account.getState()).toMatchObject({ status: 'signed-out' })
  expect(await account.getSiteSession(client)).toBeNull()
  expect(await account.getSiteBilling(client)).toBeNull()
  expect(credential?.revoked.aborted).toBe(true)
  expect(expired).toHaveBeenCalledOnce()
})
