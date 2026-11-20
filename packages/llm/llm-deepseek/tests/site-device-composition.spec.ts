/** Site login, model discovery, inference, restart and logout through the real Loader. */
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
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as AccountRoute from '@deepseek-ai/dsh-llm-deepseek-account'
import { afterEach, expect, it, vi } from 'vitest'
import { chunks, sourceModuleLoader, sse, textEvents, user } from './helpers.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
})

it('uses a persisted site grant only for Messages models and never for dashboard embedding', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-site-loader-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const requests: Request[] = []
  let rejection: 'relay' | 'upstream' | undefined
  let responsesRejected = false
  let catalogRejected = false
  const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    switch (new URL(request.url).pathname) {
      case '/api/client/v1/bootstrap': return reply({ api_version: 1, system_name: 'Site', logo: '', docs_link: '', version: 'test' })
      case '/api/client/v1/device/authorize': return reply({ request_secret: 'secret', approval_path: '/device/approve?authorization=public',
        expires_at: Math.floor(Date.now() / 1000) + 60, interval_seconds: 0.001 })
      case '/api/client/v1/device/token': return reply({ api_key: 'site-relay-key', user_id: 7, device_name: 'Harness' })
      case '/v1/models':
        expect(request.headers.has('x-api-key')).toBe(false)
        if (catalogRejected) return new Response('untrusted error detail', { status: 401 })
        expect(request.headers.get('authorization')).toBe('Bearer site-relay-key')
        return new Response(JSON.stringify({ data: [
          { id: 'site-text', supported_endpoint_types: ['anthropic'] },
          { id: 'site-reasoner', supported_endpoint_types: ['openai', 'anthropic'], messages_reasoning_efforts: ['high', 'off', 'medium', 'max', 'unknown', 'medium', {}] },
          { id: 'openai-only', supported_endpoint_types: ['openai-response'],
            responses_reasoning_efforts: ['high', 'invalid', 'medium', 'medium'] },
          { id: 'undeclared' },
        ] }))
      case '/v1/responses': {
        expect(request.headers.get('authorization')).toBe('Bearer site-relay-key')
        const body: unknown = await request.json()
        expect(body).toMatchObject({ model: 'openai-only' })
        if (!responsesRejected) expect(body).toMatchObject({ reasoning: { effort: 'high' } })
        if (responsesRejected) return Response.json({ error: { message: 'route is unavailable' } }, { status: 403 })
        const item = { type: 'message', id: 'site-reply', role: 'assistant', content: [{ type: 'output_text', text: 'Hello 世界', annotations: [] }] }
        return new Response(sse([
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'site-response', status: 'completed', output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      case '/v1/messages':
        expect(request.headers.get('authorization')).toBe('Bearer site-relay-key')
        expect(request.headers.get('anthropic-version')).toBe('2023-06-01')
        const body: unknown = await request.json()
        if (rejection === 'relay') return Response.json({ error: { type: 'new_api_error', code: 'invalid_relay_token', message: 'untrusted error detail' } }, { status: 401 })
        if (rejection === 'upstream') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'untrusted error detail' } }, { status: 401 })
        if (typeof body === 'object' && body !== null && 'model' in body && body.model === 'site-reasoner') {
          expect(body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } })
        } else {
          expect(body).toMatchObject({ model: 'site-text', max_tokens: 4096, thinking: { type: 'disabled' } })
          expect(body).not.toHaveProperty('output_config')
        }
        return new Response(sse(textEvents), { headers: { 'content-type': 'text/event-stream' } })
      default: throw new Error(`unexpected endpoint ${request.url}`)
    }
  }))
  const boot = async (authProtocol: 'site-device' | 'platform' = 'site-device') => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const modules = new Map<string, { module: unknown; config?: object }>([
      ['@deepseek-ai/dsh-llm', { module: Llm }],
      ['@deepseek-ai/dsh-agent-default-model', { module: DefaultModel, config: {
        provider: 'deepseek-account', model: 'deepseek-chat', fallbackToFirstAvailable: true, reasoningEffort: 'off',
      } }],
      ['@deepseek-ai/dsh-authorization', { module: Authorization }],
      ['@deepseek-ai/dsh-credentials-local', { module: Credentials, config: { path: join(home, 'credentials.yml'), watch: false } }],
      ['@deepseek-ai/dsh-deepseek-account', { module: Account, config: { authProtocol, platformOrigin: 'https://site.invalid', inferenceOrigin: 'https://site.invalid' } }],
      ['@deepseek-ai/dsh-deepseek-auth', { module: Auth }],
      ['@deepseek-ai/dsh-llm-deepseek-account', { module: AccountRoute, config: {
        baseURL: 'https://site.invalid', catalogProtocol: 'site', thinking: 'disabled', reasoningEffort: 'off', maxTokens: 4096, defaultContextWindow: 32768,
      } }],
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
  const client = { version: 'test', locale: 'en', timezoneOffsetSeconds: 0 }
  const first = await boot()
  expect(await first.llm.listModels('deepseek-account')).toEqual([])
  expect(await first.agentDefaultModel.resolveSelection()).toMatchObject({ model: 'deepseek-chat' })
  await first.deepseekAccount.startSignIn(client, 'http://localhost:12345', 'web')
  await vi.waitFor(async () => {
    expect(await first.deepseekAccount.getState()).toMatchObject({ status: 'credential-stored', attempt: { phase: 'succeeded' } })
  })
  const infer = (ctx: Context, model = 'site-text') => chunks(ctx.llm.stream({ provider: 'deepseek-account', model, messages: [user()] }))
  expect((await first.llm.listModels('deepseek-account')).map(model => model.id)).toEqual(['site-text', 'site-reasoner', 'openai-only'])
  expect(await first.deepseekAccount.getPlatformSession()).toBeNull()
  expect(await first.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toMatchObject({
    kind: 'grant', payload: { credentialType: 'site-api-key' },
  })
  const resolvedDefault = await first.agentDefaultModel.resolveSelection()
  expect(resolvedDefault).toMatchObject({ model: 'site-text', reasoningEffort: 'off' })
  expect(await infer(first, resolvedDefault.model)).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Hello 世界' }))
  for (const model of ['undeclared', 'not-listed']) {
    expect((await infer(first, model)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_UNSUPPORTED' } } })
  }
  const responsesInfo = await first.llm.resolveModelInfo('deepseek-account', 'openai-only')
  expect(responsesInfo.reasoning?.efforts.map(effort => effort.id)).toEqual(['medium', 'high'])
  const openai = await chunks(first.llm.stream({ provider: 'deepseek-account', model: 'openai-only',
    reasoningEffort: brandString<ReasoningEffortId>('high'), messages: [user()] }))
  expect(openai.some(event => event.type === 'block-end' && event.block.type === 'text' && event.block.text === 'Hello 世界')).toBe(true)
  expect(requests.filter(request => new URL(request.url).pathname === '/v1/responses')).toHaveLength(1)
  responsesRejected = true
  const responseFailure = (await infer(first, 'openai-only')).at(-1)
  expect(responseFailure).toMatchObject({ reason: { kind: 'error', failure: { code: 'AUTH' } } })
  expect(JSON.stringify(responseFailure)).toContain('route')
  expect(JSON.stringify(responseFailure)).not.toContain('credential in Models settings')
  expect(await first.deepseekAccount.getState()).toMatchObject({ status: 'credential-stored' })
  responsesRejected = false
  expect(requests.filter(request => new URL(request.url).pathname === '/v1/messages')).toHaveLength(1)
  const reasoning = await first.llm.resolveModelInfo('deepseek-account', 'site-reasoner')
  expect(reasoning.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'medium', 'high', 'max'])
  expect(reasoning.reasoning?.defaultEffort).toBe('off')
  const inferReasoning = (effort: string) => chunks(first.llm.stream({ provider: 'deepseek-account', model: 'site-reasoner',
    reasoningEffort: brandString<ReasoningEffortId>(effort), messages: [user()] }))
  expect(await inferReasoning('medium')).toContainEqual(expect.objectContaining({ type: 'text-delta' }))
  expect((await inferReasoning('low')).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } })
  expect(requests.filter(request => new URL(request.url).pathname === '/v1/messages')).toHaveLength(2)
  rejection = 'upstream'
  const failure = (await infer(first)).at(-1)
  expect(failure).toMatchObject({ reason: { kind: 'error', failure: { code: 'AUTH', status: 401 } } })
  expect(JSON.stringify(failure)).toContain('Your site sign-in is unchanged')
  expect(JSON.stringify(failure)).not.toContain('untrusted error detail')
  expect(await first.deepseekAccount.getState()).toMatchObject({ status: 'credential-stored' })
  rejection = undefined
  await first.fiber.dispose()
  const restarted = await boot()
  expect(await restarted.deepseekAccount.getState()).toMatchObject({ status: 'credential-stored' })
  expect(await restarted.deepseekAccount.getPlatformSession()).toBeNull()
  expect(await infer(restarted)).toContainEqual(expect.objectContaining({ type: 'text-delta' }))
  await restarted.deepseekAccount.signOut(client)
  expect(await restarted.llm.listModels('deepseek-account')).toEqual([])
  expect(await restarted.agentDefaultModel.resolveSelection()).toMatchObject({ model: 'deepseek-chat' })
  expect(await restarted.deepseekAccount.resolveRequestCredential('https://site.invalid/v1/messages')).toBeUndefined()
  await restarted.fiber.dispose()
  const signedOut = await boot()
  expect(await signedOut.deepseekAccount.getState()).toMatchObject({ status: 'signed-out' })
  expect(requests.filter(request => new URL(request.url).pathname.endsWith('/device/token'))).toHaveLength(1)
  await signedOut.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: 'https://site.invalid', token: 'old-untagged' },
  }))
  await signedOut.fiber.dispose()
  const legacy = await boot()
  expect(await legacy.deepseekAccount.getState()).toMatchObject({ status: 'signed-out' })
  await legacy.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: 'https://site.invalid', token: 'relay-not-dashboard', credentialType: 'site-api-key' },
  }))
  catalogRejected = true
  const catalogFailure = (await infer(legacy)).at(-1)
  expect(catalogFailure).toMatchObject({ reason: { kind: 'error', failure: { code: 'ACCOUNT_TOKEN_INVALID', status: 401 } } })
  expect(JSON.stringify(catalogFailure)).not.toContain('untrusted error detail')
  catalogRejected = false
  await legacy.fiber.dispose()
  const platform = await boot('platform')
  expect(await platform.deepseekAccount.getPlatformSession()).toBeNull()
  expect(await platform.deepseekAccount.getState()).toMatchObject({ status: 'signed-out' })
  await platform.fiber.dispose()
  const invalid = await boot()
  await invalid.deepseekAccount.startSignIn(client, 'http://localhost:12345', 'web')
  await vi.waitFor(async () => {
    expect(await invalid.deepseekAccount.getState()).toMatchObject({ status: 'credential-stored' })
  })
  rejection = 'relay'
  const relayFailure = (await infer(invalid)).at(-1)
  expect(relayFailure).toMatchObject({ reason: { kind: 'error', failure: { code: 'ACCOUNT_TOKEN_INVALID', status: 401 } } })
  expect(JSON.stringify(relayFailure)).not.toContain('untrusted error detail')
  expect(await invalid.deepseekAccount.getState()).toMatchObject({ status: 'signed-out' })
  expect((await infer(invalid)).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } } })
})
