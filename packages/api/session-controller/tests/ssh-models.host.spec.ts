/** A project with an obsolete provider creates and continues Sessions using desktop models. */

import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Authorization from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Account from '@deepseek-ai/dsh-deepseek-account'
import Auth from '@deepseek-ai/dsh-deepseek-auth'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as AccountRoute from '@deepseek-ai/dsh-llm-deepseek-account'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { sse, textEvents } from '../../../llm/llm-deepseek/tests/helpers.ts'
import { desktopModels } from '../src/ssh-models.ts'
import type { SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

it('creates and continues remotely stored chats with the model selected on the desktop', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-models-')))
  const desktop = new Context()
  const project = new Context()
  let catalogRequests = 0
  let modelRequests = 0
  const desktopModelServer = desktopModels(desktop)
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/catalog') catalogRequests += 1
    if (request.method === 'POST' && request.url === '/model') modelRequests += 1
    desktopModelServer(request, response)
  })
  try {
    const origin = 'https://site.invalid'
    const model = { provider: 'deepseek-account', model: 'site-text' }
    const selectedModel = { provider: 'deepseek-account', model: 'site-selected' }
    const siteRequests: unknown[] = []
    const nativeFetch = globalThis.fetch
    vi.stubEnv('ALTOAIH_HOME', join(root, 'home'))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.origin !== origin) return nativeFetch(input, init)
      const request = new Request(input, init)
      if (url.pathname === '/api/client/v1/bootstrap') {
        return Response.json({ success: true, data: { api_version: 1, system_name: 'Site', logo: '', docs_link: '', version: 'test' } })
      }
      expect(request.headers.get('authorization')).toBe('Bearer fixture-site-key')
      if (url.pathname === '/v1/models') {
        return Response.json({ data: [
          { id: model.model, supported_endpoint_types: ['anthropic'] },
          { id: selectedModel.model, supported_endpoint_types: ['anthropic'] },
        ] })
      }
      expect(url.pathname).toBe('/v1/messages')
      siteRequests.push(await request.json())
      return new Response(sse(textEvents), { headers: { 'content-type': 'text/event-stream' } })
    })
    await desktop.plugin(LlmRuntime)
    await desktop.plugin(DefaultModel, { provider: model.provider, model: 'unlisted', fallbackToFirstAvailable: true })
    await desktop.plugin(Credentials, { path: join(root, 'credentials.yml'), watch: false })
    await desktop.plugin(Authorization)
    await desktop.plugin(Account, { authProtocol: 'site-device', platformOrigin: origin, inferenceOrigin: origin })
    await desktop.plugin(Auth)
    await desktop.plugin(AccountRoute, { baseURL: origin, catalogProtocol: 'site' })
    await desktop.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), async () => ({
      kind: 'grant', payload: { version: 1, issuer: origin, token: 'fixture-site-key', credentialType: 'site-api-key' },
    }))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    vi.stubEnv('ALTOAIH_SSH_MODEL_PORT', String((server.address() as AddressInfo).port))
    vi.stubEnv('ALTOAIH_SSH_MODEL_TOKEN', '0'.repeat(64))

    await mountAgentLoopTestDependencies(project)
    await project.plugin(persistence, { root: join(root, 'sessions') })
    await project.plugin(AgentLoop, { agents: [] })
    const legacyModel = { provider: 'altoi', model: 'unregistered-model' }
    const oldId = brandString<SessionId>('session-legacy-ssh')
    const legacyAdapter = project.llm.registerAdapter([legacyModel.provider], new MockAdapter([textResponse('existing reply')]))
    const old = await project.agents.create({ sessionId: oldId, agentOptions: legacyModel, meta: { cwd: root } })
    old.agent.model.select(legacyModel)
    old.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'existing prompt' }], source: { kind: 'user' } }))
    await old.agent.whenIdle()
    await project.sessions.flush(old.agent.session)
    await old.dispose()
    legacyAdapter()
    expect(project.agents.get(oldId)).toBeUndefined()

    project.provide('workspaceRegistry', {
      sshProjectHost: true, list: () => [], archivedSessionIds: [],
    } as never)
    await project.plugin(DefaultModel, { ...legacyModel, fallbackToFirstAvailable: true })
    const remote = await createSessionTestRemote(project, { defaultModelSelection: () => legacyModel, cwd: root })
    const catalog = await remote.modelCatalog()
    if (!catalog.ok) throw catalog.error
    expect(catalog.value.default).toEqual(model)
    expect(catalog.value.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: model.provider,
        models: expect.arrayContaining([expect.objectContaining({ id: model.model })]),
      }),
    ]))
    const created = await remote.create({})
    if (!created.ok) throw created.error
    const catalogsBeforeSelection = catalogRequests
    const modelsBeforeSelection = modelRequests
    const selected = await remote.selectModel({ sessionId: created.value.sessionId, ...selectedModel })
    if (!selected.ok) throw selected.error
    expect(selected.value.selected).toEqual(selectedModel)
    expect(catalogRequests).toBe(catalogsBeforeSelection)
    expect(modelRequests).toBe(modelsBeforeSelection)
    const prompt = async (sessionId: SessionId, text: string) => {
      const result = await remote.prompt({
        sessionId, requestId: brandString<SessionRequestId>(text), mode: 'queue', content: [{ type: 'text', text }],
      })
      if (!result.ok) throw result.error
      const agent = project.agents.get(sessionId)!
      await agent.whenIdle()
      await project.sessions.flush(agent.session)
      const stored = await project.sessionPersistence.open(sessionId, 'read')
      try {
        return (await stored.read()).events.flatMap(event => event.type === 'assistant/message' ? [event.data.message.content] : [])
      } finally {
        await stored.close()
      }
    }
    const catalogsBeforePrompts = catalogRequests
    const modelsBeforePrompts = modelRequests
    expect(await prompt(created.value.sessionId, 'new prompt')).toEqual([
      [{ type: 'text', text: 'Hello 世界' }],
    ])
    expect(catalogRequests).toBe(catalogsBeforePrompts)
    expect(modelRequests).toBe(modelsBeforePrompts)
    expect(await prompt(oldId, 'continue old chat')).toEqual([
      [{ type: 'text', text: 'existing reply' }],
      [{ type: 'text', text: 'Hello 世界' }],
    ])
    expect(catalogRequests).toBe(catalogsBeforePrompts)
    expect(modelRequests).toBe(modelsBeforePrompts)

    const catalogsBeforeExplicitRefresh = catalogRequests
    const refreshed = await remote.modelCatalog()
    if (!refreshed.ok) throw refreshed.error
    expect(refreshed.value.default).toEqual(model)
    expect(catalogRequests).toBe(catalogsBeforeExplicitRefresh + 1)
    expect(project.agents.get(oldId)?.model.current()).toEqual(model)
    expect(siteRequests).toEqual([
      expect.objectContaining({ model: selectedModel.model }),
      expect.objectContaining({ model: model.model }),
    ])

    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    const refused = await fetch(url + '/generate', {
      method: 'POST',
      body: JSON.stringify({ ...model, messages: [{ role: 'user', content: [{ type: 'file', attachment: {} }] }] }),
    })
    expect(refused.status).toBe(400)
    expect(siteRequests).toHaveLength(2)

    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    expect(await remote.create({})).toMatchObject({ ok: false, error: { code: 'session/desktop-model-disconnected' } })
  } finally {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    await project.fiber.dispose()
    await desktop.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
