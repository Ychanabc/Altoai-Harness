/** Real Go controller/database acceptance; launched by TestClientDeviceHarnessIntegration. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/types'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Authorization from '@deepseek-ai/dsh-authorization'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import Account from '@deepseek-ai/dsh-deepseek-account'
import Auth from '@deepseek-ai/dsh-deepseek-auth'
import Llm from '@deepseek-ai/dsh-llm'
import * as AccountRoute from '@deepseek-ai/dsh-llm-deepseek-account'
import { expect, it } from 'vitest'
import { chunks, sourceModuleLoader, user } from './helpers.ts'

const origin = process.env.DSH_GO_DEVICE_ORIGIN

it.skipIf(origin === undefined)('pairs with Go, reads real account projections, relays Messages, restarts and logs out locally', async () => {
  if (origin === undefined || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('expected isolated Go loopback host')
  const browserToken = process.env.DSH_GO_DEVICE_BROWSER_TOKEN
  if (!browserToken) throw new Error('missing isolated dashboard session')
  const home = await mkdtemp(join(tmpdir(), 'dsh-go-device-'))
  const contexts: Context[] = []
  const client = { version: 'acceptance', locale: 'en', timezoneOffsetSeconds: 0 }
  const model = 'claude-sonnet-4-20250514'
  const defaultGroups: unknown = expect.arrayContaining(['default'])
  const numericMetadata: unknown = expect.any(Number)
  const textMetadata: unknown = expect.any(String)
  const usableGroups: unknown = expect.objectContaining({ default: textMetadata })
  const endpointTypes: unknown = expect.arrayContaining(['anthropic'])
  const catalogModel: unknown = expect.objectContaining({ id: model, supported_endpoint_types: endpointTypes, messages_reasoning_efforts: ['off', 'medium'] })
  const boot = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const modules = new Map<string, { module: unknown; config?: object }>([
      ['@deepseek-ai/dsh-llm', { module: Llm }],
      ['@deepseek-ai/dsh-authorization', { module: Authorization }],
      ['@deepseek-ai/dsh-credentials-local', { module: Credentials, config: { path: join(home, 'credentials.yml'), watch: false } }],
      ['@deepseek-ai/dsh-deepseek-account', { module: Account, config: { authProtocol: 'site-device', platformOrigin: origin,
        inferenceOrigin: origin, allowLoopbackHttp: true, requestTimeoutMs: 10000 } }],
      ['@deepseek-ai/dsh-deepseek-auth', { module: Auth }],
      ['@deepseek-ai/dsh-llm-deepseek-account', { module: AccountRoute, config: { baseURL: origin, catalogProtocol: 'site',
        thinking: 'disabled', reasoningEffort: 'off', maxTokens: 64, defaultContextWindow: 32768 } }],
    ])
    for (const name of modules.keys()) {
      const dir = join(home, 'node_modules', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '0.2.2-rc.5', type: 'module' }))
    }
    const config = join(home, 'cordis.yml')
    await writeFile(config, JSON.stringify([...modules].map(([name, { config }]) => ({ name, config }))))
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = sourceModuleLoader(async (name) => {
      const found = modules.get(name)
      if (found === undefined) throw new Error(`unexpected module ${name}`)
      return found.module
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    return ctx
  }
  const infer = (ctx: Context, reasoningEffort?: ReasoningEffortId) => chunks(ctx.llm.stream({ provider: 'deepseek-account', model, messages: [user('Say hello')], ...reasoningEffort === undefined ? {} : { reasoningEffort } }))
  try {
    const first = await boot()
    expect(await first.llm.listModels('deepseek-account')).toEqual([])
    await first.deepseekAccount.startSignIn(client, origin, 'web')
    const controller = new AbortController()
    const updates = first.deepseekAccount.watch(AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]))
    try {
      let approved = false
      for await (const update of updates) {
        const attempt = update.state.attempt
        if (attempt?.phase === 'failed') throw new Error(`device pairing failed: ${attempt.errorCode}`)
        if (!approved && attempt?.authorizeUrl) {
          const url = new URL(attempt.authorizeUrl)
          expect(url.origin).toBe(origin)
          const body = JSON.stringify({ authorization_id: url.searchParams.get('authorization'), approved: true })
          const anonymous = await fetch(origin + '/api/client/v1/device/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
          expect(anonymous.status).toBe(401)
          const response = await fetch(origin + '/api/client/v1/device/approve', { method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${browserToken}` }, body })
          expect(await response.json()).toMatchObject({ success: true })
          approved = true
        }
        if (update.state.status === 'credential-stored') break
      }
      expect(approved).toBe(true)
    } finally { controller.abort() }
    expect(await first.deepseekAccount.getState()).toMatchObject({ status: 'credential-stored' })
    expect(await first.deepseekAccount.getSiteSession(client)).toMatchObject({ status: 'ready', value: {
      profile: { id: process.env.DSH_GO_DEVICE_USER_ID, name: 'Acceptance user', contact: 'acceptance@example.invalid' },
      group: 'default', deviceGroup: 'default', usableGroups: defaultGroups, quota: { remain: 1000000, used: 23 },
      quotaPerUnit: numericMetadata, quotaDisplayType: textMetadata,
    } })
    expect(await first.deepseekAccount.getSiteBilling(client)).toMatchObject({ status: 'ready', value: {
      quota: { remain: 1000000, used: 23 }, subscriptions: [expect.objectContaining({ title: 'Acceptance monthly', planAvailable: true,
        total: 9000, used: 120, unlimited: false, hourQuota: 800, hourUsed: 30, hourUnlimited: false, resetPeriod: 'monthly' })],
    } })
    expect(await first.deepseekAccount.getPlatformSession()).toBeNull()
    const credential = await first.deepseekAccount.resolveRequestCredential(origin + '/v1/messages')
    expect(credential).toBeDefined()
    const rawSession = await fetch(origin + '/api/client/v1/device/session', { headers: credential!.headers })
    expect(rawSession.status).toBe(200)
    const session: unknown = await rawSession.json()
    expect(session).toMatchObject({ success: true, data: {
      user: { group: 'default' }, token: { effective_group: 'default' },
      usable_groups: usableGroups,
    } })
    const rawCatalog = await fetch(origin + '/v1/models', { headers: credential!.headers })
    expect(rawCatalog.status).toBe(200)
    expect(await rawCatalog.json()).toMatchObject({ data: [catalogModel] })
    const forbiddenDashboard = await fetch(origin + '/api/client/v1/session', { headers: credential!.headers })
    expect(forbiddenDashboard.status).not.toBe(200)
    expect((await first.llm.listModels('deepseek-account')).map(entry => entry.id)).toEqual([model])
    expect(await infer(first)).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Hello from isolated Go upstream' }))
    await first.fiber.dispose()
    const restarted = await boot()
    expect(await restarted.deepseekAccount.getState()).toMatchObject({ status: 'credential-stored' })
    expect(await restarted.deepseekAccount.getSiteSession(client)).toMatchObject({ status: 'ready' })
    expect((await restarted.llm.resolveModelInfo('deepseek-account', model)).reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'medium'])
    expect(await infer(restarted, brandString<ReasoningEffortId>('medium'))).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Hello from isolated Go upstream' }))
    await restarted.deepseekAccount.signOut(client)
    expect(await restarted.deepseekAccount.getSiteSession(client)).toBeNull()
    expect(await restarted.deepseekAccount.getSiteBilling(client)).toBeNull()
    expect(await restarted.llm.listModels('deepseek-account')).toEqual([])
    expect(await restarted.deepseekAccount.resolveRequestCredential(origin + '/v1/messages')).toBeUndefined()
    expect(await restarted.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toBeUndefined()
    await restarted.fiber.dispose()
    const signedOut = await boot()
    expect(await signedOut.deepseekAccount.getState()).toMatchObject({ status: 'signed-out' })
    expect(await signedOut.deepseekAccount.getSiteSession(client)).toBeNull()
    expect(await signedOut.deepseekAccount.getSiteBilling(client)).toBeNull()
    expect(await signedOut.llm.listModels('deepseek-account')).toEqual([])
    expect(await signedOut.deepseekAccount.resolveRequestCredential(origin + '/v1/messages')).toBeUndefined()
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
