/** Account-token authentication, the account model listing, and version gating for the DeepSeek account route. */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, APP_IDENTITY, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, authInjectionFrom, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { DeepSeekAuthorization } from '@deepseek-ai/dsh-deepseek-auth'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  catalogModelInfo, createModelListingCache, refuseListedModel, registerDeepSeekProvider, requestModelListing,
  resolveAdapterOptions, resolveListedCatalog,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekRequestAuth, ListedCatalog, ListingView, ModelListing, ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { cancelAccountTasks, installAccountTaskCancellation } from './account-tasks.ts'
import { Config, plainAccountOptions, resolveAccountOptions } from './config.ts'

export { Config } from './config.ts'
export const name = 'llm-deepseek-account'
export const inject = ['llm', 'deepseekAuth']

const PROVIDER = 'deepseek-account'
/** Console tag of listing diagnostics; product profiles mount no console exporter for `ctx.logger`. */
const LOG_TAG = '[llm-deepseek-account]'

/** Connection facts of one account operation: protocol settings plus the catalog resolved with them. */
interface AccountConnection extends ResolvedDeepSeekOptions {
  readonly catalog: ListedCatalog
  readonly listingError?: LlmError
  readonly site: boolean
  readonly authenticated: boolean
}

export function apply(ctx: Context, config: Config): void {
  const environment = launchEnvironmentOf(ctx)
  const settings = () => resolveAccountOptions(plainAccountOptions(config), environment)
  settings()
  // Every other DeepSeek consumer billed by the account sends the sign-in to this route's deployment.
  ctx.effect(() => ctx.deepseekAuth.connect('account', PROVIDER, () => ({ baseURL: settings().protocol.baseURL })), 'llm-deepseek-account: account deployment')
  const supported = resolveAdapterOptions({}).models
  /**
   * The account sign-in `ctx.deepseekAuth` releases for one destination under the deployment at `baseURL`; absent
   * without an allowed signed-in account or without the account service.
   */
  const requestCredential = (baseURL: string, endpoint: string): Promise<DeepSeekAuthorization | undefined> =>
    ctx.deepseekAuth.authorize({
      consumer: name, accepts: ['account'], billing: 'account', destination: { url: endpoint }, connections: { account: { baseURL } },
    })
  /** The failure of a request whose account signed out before it finished: the code a request made after the sign-out fails with. */
  const signedOutMidRequest = (cause: unknown) => new LlmError(
    'The DeepSeek account signed out before this request finished. Sign in to DeepSeek to use the account provider.',
    'ACCOUNT_SIGN_IN_REQUIRED',
    { cause },
  )
  const resolveAuth = async (connection: AccountConnection, endpoint: string): Promise<DeepSeekRequestAuth | undefined> => {
    const { site } = connection
    const credential = await requestCredential(connection.baseURL, endpoint)
    if (credential === undefined) return undefined
    return {
      ...credential,
      onRequestError: async (error) => {
        try {
          // A sign-out ends the requests that carry its token, so it is the failure of any request that fails after it.
          if (credential.revoked?.aborted === true) return signedOutMidRequest(error)
          if (!(error instanceof LlmError)) return error
          if (error.code === QUOTA_EXCEEDED_CODE) {
            return new LlmError(error.message, ACCOUNT_QUOTA_EXCEEDED_CODE, { ...error.failure, cause: error })
          }
          if (error.failure.status !== 401) return error
          if (site && error.code !== 'SITE_RELAY_TOKEN_REJECTED') {
            return new LlmError('The Messages route returned HTTP 401 without a site credential rejection. Your site sign-in is unchanged. Try another Official site model or ask the site operator to check the upstream channel.',
              'AUTH', { ...error.failure, cause: error })
          }
          const rejected = new LlmError(site
            ? 'The site rejected this device credential. Sign in to the site again and retry with an Official site model.'
            : error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
          await credential.reject?.()
          return rejected
        } finally {
          // A request can outlive this plugin and the sign-out listener it mounts. Once the credential it carried is
          // signed out, by the user or by the rejection above, the request ends this route's tasks itself.
          if (credential.revoked?.aborted === true) cancelAccountTasks(ctx, PROVIDER)
        }
      },
    }
  }
  const missingCredential = (connection: AccountConnection) => new LlmError(
    connection.site ? 'Sign in to the site to use Official site models.'
      : 'Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.',
    'ACCOUNT_SIGN_IN_REQUIRED',
  )
  const catalog = createModelListingCache(ctx, name, PROVIDER, {
    retainOnError: settings().catalogProtocol !== 'site',
    settings: () => settings().catalog,
    credential: async url => (await requestCredential(settings().protocol.baseURL, url))?.headers,
    load: async (url, headers, signal) => {
      const format = settings().catalogProtocol
      try { return await requestModelListing(url, headers, signal, format) }
      catch (error) {
        if (format !== 'site' || !(error instanceof LlmError) || error.failure.status !== 401) throw error
        throw new LlmError('The site rejected authentication for its model catalog (HTTP 401). Sign out and sign in again, then retry with an Official site model.',
          'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
      }
    },
  })
  ctx.on('credentials/record-updated', (key) => {
    if (key !== 'deepseek-account-platform/default') return
    catalog.invalidate()
    ctx.emit('llm/models-updated', PROVIDER)
  })
  ctx.on('deepseek-account/signed-out', () => { catalog.invalidate() })
  ctx.on('loader/volatile-update', () => {
    catalog.invalidate()
    ctx.emit('llm/models-updated', PROVIDER)
  })
  let loggedListing: ModelListing | undefined
  /** Resolve the catalog, reporting each listing's hidden entries and dropped badges once. */
  const connectionOf = (view: ListingView): AccountConnection => {
    const resolved = settings()
    const result = resolveListedCatalog({
      listing: view.listing?.entries,
      supported: resolved.catalogProtocol === 'site'
        ? (view.listing?.entries ?? []).filter(entry => entry.capabilities.usable).map(entry => ({ id: entry.id }))
        : supported,
      overrides: resolved.modelOverrides,
      routeMaxTokens: resolved.protocol.maxTokens,
      clientVersion: APP_IDENTITY.version,
    })
    if (view.listing !== loggedListing) {
      loggedListing = view.listing
      for (const problem of result.problems) console.warn(LOG_TAG, problem)
    }
    return { ...resolved.protocol, models: result.resolution, catalog: result,
      site: resolved.catalogProtocol === 'site', authenticated: view.authenticated,
      ...resolved.catalogProtocol === 'site' && view.error !== undefined ? { listingError: view.error } : {},
    }
  }
  const entry = { provider: PROVIDER, displayName: 'Altoai Official Models', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] }
  const directory = ctx.llm.registerConfigurableProviders([entry])
  let reportedError: string | undefined
  /** Publish override diagnostics on the provider directory. */
  const discovered = (view: ListingView): AccountConnection => {
    const connection = connectionOf(view)
    const error = settings().catalogProtocol === 'site' && view.authenticated
      ? view.error !== undefined ? `${view.error.code}: ${view.error.message}`
        : view.listing?.entries.length === 0 ? 'MODEL_CATALOG_EMPTY: No models are available for this account group'
          : connection.catalog.offered.length === 0 ? 'MODEL_CATALOG_INCOMPATIBLE: No models declare a supported site endpoint'
            : undefined
      : connection.catalog.overrideErrors.length === 0 ? undefined : connection.catalog.overrideErrors.join('; ')
    if (error !== reportedError) {
      reportedError = error
      directory.replace([error === undefined ? entry : { ...entry, error }])
    }
    return connection
  }
  const responseProfiles = () => {
    const connection = connectionOf(catalog.current())
    return resolveProfiles({
      [PROVIDER]: {
        displayName: 'Altoai Official Models',
        api: 'openai-responses',
        baseURL: new URL('/v1', connection.baseURL).href,
        models: connection.catalog.offered
          .filter(model => connection.catalog.protocols.get(model.id) === 'openai-responses')
          .map(model => ({
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
            input: [...model.inputModalities ?? ['text']],
            ...model.responsesReasoningEfforts === undefined ? {} : {
              reasoningEfforts: Object.fromEntries(model.responsesReasoningEfforts.map(level => [level, level])),
            },
          })),
      },
    })
  }
  const responseAdapter = new PiAiAdapter({
    profiles: responseProfiles,
    resolveApiKey: async () => {
      const connection = connectionOf(catalog.current())
      const authorization = await resolveAuth(connection, connection.baseURL)
      if (authorization === undefined) throw missingCredential(connection)
      const value = new Headers(authorization.headers).get('authorization')
      if (value === null || !value.startsWith('Bearer ')) {
        throw new LlmError('The site credential does not provide a Bearer token for OpenAI Responses.', 'MISSING_CREDENTIAL')
      }
      return value.slice('Bearer '.length)
    },
    auth: authInjectionFrom(ctx),
    authFailureMessage: () => 'The Official site model rejected the OpenAI Responses route (HTTP 401 or 403). Your site sign-in is unchanged; choose another Official site model or ask the site operator to enable this model route.',
  })
  const ownsResponses = (model: string): boolean =>
    connectionOf(catalog.current()).catalog.protocols.get(model) === 'openai-responses'
  registerDeepSeekProvider<AccountConnection>(ctx, PROVIDER, {
    providerName: 'Altoai Official Models',
    options: () => connectionOf(catalog.current()),
    connect: async signal => connectionOf(await catalog.view(settings().catalog, signal)),
    resolveAuth,
    missingCredential,
    admit: (connection, model) => {
      if (connection.site && !connection.authenticated) throw missingCredential(connection)
      if (connection.listingError !== undefined) throw connection.listingError
      refuseListedModel(model, connection.catalog.refusals.get(model))
      if (connection.site && !connection.catalog.protocols.has(model)) {
        throw new LlmError(`Model "${model}" is not in the authenticated site catalog`, 'MODEL_UNSUPPORTED')
      }
    },
    responses: { adapter: responseAdapter, owns: ownsResponses },
    discoverModels: async (provider) => {
      const view = await catalog.view(settings().catalog)
      const { offered, badges } = discovered(view).catalog
      if (!view.authenticated) return []
      return offered.map(model => catalogModelInfo(provider, model, badges.get(model.id)))
    },
  })
  installAccountTaskCancellation(ctx, PROVIDER)
}
