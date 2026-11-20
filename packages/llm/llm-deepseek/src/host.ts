/** Shared Host wiring for the DeepSeek protocol adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-fs'
import { LlmAdapter, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { DeepSeekAdapter } from './adapter.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from './types.ts'
import { requestModelListing } from './listing.ts'
import { ModelListingCache, type ListingCacheDependencies } from './listing-cache.ts'

/**
 * Own a route's listing refreshes, stderr diagnostics, and catalog-change notifications.
 * @param ctx - provider plugin lifetime.
 * @param owner - plugin name used in diagnostics.
 * @param provider - route whose catalog changes.
 * @param dependencies - current configuration and credential headers; `load` defaults to the official `/models` request.
 * @returns the cache, disposed with the provider after its active work settles.
 */
export function createModelListingCache(
  ctx: Context, owner: string, provider: string,
  dependencies: Pick<ListingCacheDependencies, 'settings' | 'credential'> & Partial<Pick<ListingCacheDependencies, 'load' | 'retainOnError'>>,
): ModelListingCache {
  const tag = `[${owner}]`
  const cache = new ModelListingCache({
    ...dependencies,
    load: dependencies.load ?? requestModelListing,
    now: () => Date.now(),
    // ACP reserves stdout for protocol messages, including during successful catalog loads.
    info: (message) => { console.error(tag, message) },
    warn: (message) => { console.warn(tag, message) },
    changed: () => { ctx.emit('llm/models-updated', provider) },
  })
  ctx.effect(() => () => cache.dispose(), `${owner}: model listing`)
  return cache
}

/**
 * Register one provider with request-local transport services and live retry policy.
 * @param ctx - provider plugin lifetime with the LLM registry injected.
 * @param provider - exact route owned by this plugin.
 * @param dependencies - provider-owned discovery, credential, and configuration callbacks.
 */
export function registerDeepSeekProvider<C extends DeepSeekConnectionOptions>(
  ctx: Context, provider: string, dependencies: Pick<DeepSeekAdapterOptions<C>,
  'options' | 'resolveAuth' | 'missingCredential' | 'providerName' | 'discoverModels' | 'connect' | 'admit'> & {
    /** Optional OpenAI Responses delegate for catalog-selected models. */
    responses?: { readonly adapter: LlmAdapter; readonly owns: (model: string) => boolean }
  }): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  let userId: AnonymousUserId | undefined
  // These conditions repeat on every request of a route; log each first occurrence only.
  const degradedReplays = new Set<string>()
  const omittedRoutes = new Set<string>()
  const unacceptedRoutes = new Set<string>()
  const adapter = new DeepSeekAdapter({
    ...dependencies,
    resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
    onReplayDegrade: ({ provider, model, reason }) => {
      const key = `${provider}/${model}\u0000${reason}`
      if (degradedReplays.has(key)) return
      degradedReplays.add(key)
      ctx.logger.warn(`llm-deepseek: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    onExtensionsOmitted: ({ provider, model, fields, error }) => {
      const route = `${provider}/${model}`
      if (omittedRoutes.has(route)) return
      omittedRoutes.add(route)
      ctx.logger.warn(`llm-deepseek: sending route "${route}" without request extension fields ${fields.join(', ')} because they failed to serialize: %o`, error)
    },
    onExtensionsUnaccepted: ({ provider, model, error }) => {
      const route = `${provider}/${model}`
      if (unacceptedRoutes.has(route)) return
      unacceptedRoutes.add(route)
      ctx.logger.warn(`llm-deepseek: route "${route}" request extension acceptance failed; contributors resend on a later request: %o`, error)
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
  const routed = dependencies.responses === undefined ? adapter : new class extends LlmAdapter {
    private target(model: string): LlmAdapter {
      return dependencies.responses?.owns(model) === true ? dependencies.responses.adapter : adapter
    }
    override providerInfo(route: string): LlmProviderInfo { return adapter.providerInfo(route) }
    override providerRetryPolicy(route: string): ResolvedRetryPolicy | undefined {
      return adapter.providerRetryPolicy(route)
    }
    override listModels(route: string): Promise<readonly LlmModelInfo[]> { return adapter.listModels(route) }
    override resolveModel(route: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      return this.target(model).resolveModel(route, model, signal)
    }
    override prepareCall(route: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
      return this.target(model).prepareCall(route, model, signal)
    }
    override stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.target(options.model).stream(options) }
    override imageRequestPricing(route: string, model: string) { return this.target(model).imageRequestPricing(route, model) }
    override imageRequestTarget(route: string, model: string, image: ImageAttachmentRef) {
      return this.target(model).imageRequestTarget(route, model, image)
    }
  }()
  const registration = ctx.llm.registerAdapter([provider], routed)
  let registeredPolicy = dependencies.options().retryPolicy
  ctx.on('loader/volatile-update', () => {
    let policy: typeof registeredPolicy
    try { policy = dependencies.options().retryPolicy }
    catch (error) { ctx.logger.warn(error); return }
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([provider])
    registeredPolicy = policy
  })
}
