/** Desktop model calls carried over the authenticated SSH connection. */

import { once } from 'node:events'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  LlmAdapter, type AdapterRegistrationHandle, type GenerateOptions,
  type LlmResolvedModelInfo, type ReasoningEffortId, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { buildModelCatalog } from './catalog.ts'

const metadataTimeoutMs = 15_000
const maxRequestBytes = 16 * 1024 * 1024
const maxFrameSize = 4 * 1024 * 1024
const text = z.string()
const id = z.string().min(1).max(1024)
const effort = id.transform(value => brandString<ReasoningEffortId>(value))
const route = z.object({ provider: id, model: id })
const selection = route.extend({ reasoningEffort: effort.optional() })
const entry = z.object({ id, name: text, description: text.optional() })
const catalog = z.object({
  default: selection,
  groups: z.array(entry.extend({ models: z.array(entry) })),
})
const model = entry.extend({
  provider: id,
  defaultMaxTokens: z.number().int().positive().optional(),
  context: z.object({ contextWindow: z.number().int().positive() }).optional(),
  reasoning: z.object({
    efforts: z.array(entry.extend({ id: effort })),
    defaultEffort: effort.optional(),
  }).optional(),
})
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text }),
  z.object({ type: z.literal('reasoning'), text }),
  z.object({ type: z.literal('tool-call'), id, name: id, arguments: text }),
])
const message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  id: id.optional(),
  source: z.object({ kind: id }).passthrough().optional(),
  content: z.array(block),
  toolCallId: id.optional(),
  isError: z.boolean().optional(),
})
const generate = selection.extend({
  messages: z.array(message),
  system: text.optional(),
  tools: z.array(z.object({ name: id, description: text, parameters: z.record(text, z.unknown()) })).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(text).optional(),
  sessionId: id.optional(),
  purpose: id.optional(),
})

/** Only one locally advertised model route can be requested per authenticated call. */
async function serve(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/catalog') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(await buildModelCatalog(ctx)))
    return
  }
  if (request.method !== 'POST' || (request.url !== '/model' && request.url !== '/generate')) {
    response.writeHead(404).end()
    return
  }
  const stop = new AbortController()
  response.once('close', () => stop.abort())
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(10 * 60_000)])
  const value = await readRequest(request)
  const selected = route.parse(value)
  if (!ctx.llm.listProviders().some(provider => provider.id === selected.provider)
    || !(await ctx.llm.listModels(selected.provider)).some(model => model.id === selected.model)) {
    response.writeHead(404).end()
    return
  }
  if (request.url === '/model') {
    const info = await ctx.llm.resolveModelInfo(selected.provider, selected.model, signal)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(info))
    return
  }
  // The peer supplies model content only. File and image references cannot
  // select objects in the desktop attachment store.
  const options = generate.parse(value) as unknown as GenerateOptions
  const prepared = await ctx.llm.prepareCall(options, signal)
  response.writeHead(200, { 'content-type': 'application/x-ndjson' })
  response.flushHeaders()
  for await (const chunk of prepared.stream({ ...options, ...prepared.config, signal })) {
    signal.throwIfAborted()
    const frame = JSON.stringify(chunk) + '\n'
    if (Buffer.byteLength(frame) > maxFrameSize) throw new Error('Desktop model response frame is too large')
    if (!response.write(frame)) await once(response, 'drain', { signal })
  }
  response.end()
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const blocks: Buffer[] = []
  let length = 0
  for await (const block of request as AsyncIterable<Buffer>) {
    length += block.length
    if (length > maxRequestBytes) throw new Error('Desktop model request is too large')
    blocks.push(block)
  }
  return JSON.parse(Buffer.concat(blocks).toString('utf8')) as unknown
}

/**
 * Handle model requests from one SSH project using the desktop's live adapters.
 * @param ctx - Desktop Host context.
 * @returns HTTP listener invoked after the workspace carrier checks its connection token.
 */
export function desktopModels(ctx: Context): RequestListener {
  return (request, response) => {
    void serve(ctx, request, response).catch((error) => {
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      // No provider bodies, URLs, or credential values cross on setup failures.
      response.writeHead(error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 503).end()
    })
  }
}

/** Adapter roster of the desktop connected to this SSH project process. */
export class SshProjectModels extends LlmAdapter {
  private view: z.output<typeof catalog> | undefined
  private registration?: AdapterRegistrationHandle
  private refreshing: Promise<ModelSelection> | undefined
  /** Exact-model capability metadata already read across this SSH carrier. */
  private readonly modelInfo = new Map<string, LlmResolvedModelInfo>()
  /** Guards against a stale in-flight `/model` response repopulating a refreshed roster. */
  private modelInfoGeneration = 0
  private readonly lifetime = new AbortController()

  constructor(private readonly ctx: Context, private readonly endpoint: string, private readonly token: string) {
    super()
  }

  dispose(): void {
    this.lifetime.abort()
    this.registration?.()
  }

  refresh(): Promise<ModelSelection> {
    const current = this.current()
    return current === undefined ? this.reload() : Promise.resolve(current)
  }

  /** Refresh the desktop roster when a caller explicitly needs current model choices. */
  reload(): Promise<ModelSelection> {
    return this.refreshing ??= this.load().finally(() => { this.refreshing = undefined })
  }

  async agentOptions(): Promise<AgentOptions> {
    const fallback = await this.refresh()
    const current = () => {
      const selected = this.view?.default
      return selected !== undefined && this.supports(selected) ? selected : fallback
    }
    return {
      get provider() { return current().provider },
      get model() { return current().model },
      get reasoningEffort() { return current().reasoningEffort },
    }
  }

  supports(selected: Pick<ModelSelection, 'provider' | 'model'>): boolean {
    return this.view?.groups.some(group => group.id === selected.provider
      && group.models.some(model => model.id === selected.model)) === true
  }

  private current(): ModelSelection | undefined {
    const selected = this.view?.default
    if (selected === undefined || !this.supports(selected)) return undefined
    return {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.view?.groups.find(group => group.id === provider)?.name ?? provider }
  }

  override async listModels(provider: string) {
    return this.view?.groups.find(group => group.id === provider)?.models.map(({ id, name, description }) => ({
      id, name, provider, ...(description === undefined ? {} : { description }),
    })) ?? []
  }

  override async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const key = JSON.stringify([provider, modelId])
    const cached = this.modelInfo.get(key)
    if (cached !== undefined) return cached
    const generation = this.modelInfoGeneration
    const response = await this.fetch('/model', { provider, model: modelId }, signal, metadataTimeoutMs)
    const info = model.parse(await response.json())
    const resolved: LlmResolvedModelInfo = {
      id: info.id, provider: info.provider, name: info.name, inputModalities: ['text'],
      ...(info.description === undefined ? {} : { description: info.description }),
      ...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
      ...(info.context === undefined ? {} : { context: info.context }),
      ...(info.reasoning === undefined ? {} : {
        reasoning: {
          efforts: info.reasoning.efforts.map(({ id, name, description }) => ({
            id, name, ...(description === undefined ? {} : { description }),
          })),
          ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
        },
      }),
    }
    if (generation === this.modelInfoGeneration) this.modelInfo.set(key, resolved)
    return resolved
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const { signal, ...input } = options
    const controller = new AbortController()
    try {
      const bound = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
      const response = await this.fetch('/generate', input, bound, 10 * 60_000)
      if (response.body === null) throw unavailable()
      const decoder = new TextDecoder()
      let pending = ''
      let finished = false
      const reader = response.body.getReader()
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          pending += decoder.decode(next.value, { stream: true })
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            if (newline > maxFrameSize || finished) throw unavailable()
            const chunk = JSON.parse(pending.slice(0, newline)) as StreamChunk
            pending = pending.slice(newline + 1)
            finished = chunk.type === 'finish'
            yield chunk
          }
          if (pending.length > maxFrameSize) throw unavailable()
        }
      } finally {
        reader.releaseLock()
      }
      if (!finished || pending !== '') throw unavailable()
    } finally {
      controller.abort()
    }
  }

  private async load(): Promise<ModelSelection> {
    const response = await this.fetch('/catalog', undefined, undefined, metadataTimeoutMs)
    const next = catalog.parse(await response.json())
    this.lifetime.signal.throwIfAborted()
    const previous = this.view
    this.view = next
    const providers = next.groups.map(group => group.id)
    try {
      if (this.registration !== undefined) this.registration.replace(providers)
      else if (providers.length !== 0) this.registration = this.ctx.llm.registerAdapter(providers, this)
    } catch (error) {
      this.view = previous
      throw error
    }
    if (!this.supports(next.default)) {
      throw new RemoteError('session/model-unavailable',
        'Select an available model in the desktop app before using this SSH workspace.',
        { provider: next.default.provider, model: next.default.model })
    }
    this.modelInfoGeneration += 1
    this.modelInfo.clear()
    const { provider, model, reasoningEffort } = next.default
    return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }

  private async fetch(path: string, body: object | undefined, signal: AbortSignal | undefined, timeout: number): Promise<Response> {
    const operation = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeout), ...(signal === undefined ? [] : [signal])])
    try {
      const response = await fetch(this.endpoint + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: operation,
      })
      if (response.ok) return response
      await response.body?.cancel()
      if (response.status === 404 && body !== undefined) {
        const selected = route.parse(body)
        throw new RemoteError('session/model-unavailable', 'This model is unavailable in the desktop app.', selected)
      }
      throw unavailable()
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof RemoteError) throw error
      throw unavailable()
    }
  }
}

function unavailable() {
  return new RemoteError('session/desktop-model-disconnected',
    'The desktop model connection is unavailable. Reconnect the SSH workspace and check the model in the desktop app.', {})
}

/**
 * Read the loopback address and temporary capability supplied by the SSH launcher.
 * @param ctx - SSH project Host context.
 * @returns the model adapter, or undefined for a standalone project Host.
 */
export function sshProjectModels(ctx: Context): SshProjectModels | undefined {
  const port = process.env.ALTOAIH_SSH_MODEL_PORT
  const token = process.env.ALTOAIH_SSH_MODEL_TOKEN
  if (port === undefined && token === undefined) return undefined
  if (port === undefined || !/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535
    || token === undefined || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error('Invalid SSH desktop model configuration')
  }
  return new SshProjectModels(ctx, 'http://127.0.0.1:' + port, token)
}
