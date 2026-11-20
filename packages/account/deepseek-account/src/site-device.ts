/** Website device authorization; request secrets and API keys stay in the Host. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { AccountUserId, SiteAccountSession, SiteAccountBilling, SiteQuotaMetadata } from './types.ts'
import { AccountUnauthorizedError, PlatformAuthError } from './protocol.ts'

const envelope = z.object({ success: z.boolean(), code: z.string().optional(), data: z.unknown().optional() })
const started = z.object({ request_secret: z.string().min(1), approval_path: z.string().min(1),
  expires_at: z.number().int().positive(), interval_seconds: z.number().positive().max(300) })
const issued = z.object({ api_key: z.string().regex(/^[\x21-\x7e]+$/), user_id: z.number().int().positive(), device_name: z.string() })
const bootstrap = z.object({ api_version: z.literal(1), system_name: z.string().min(1), logo: z.string(),
  docs_link: z.string(), version: z.string() })

/** Public website branding, without deployment credentials. */
export type SiteBrand = z.infer<typeof bootstrap>
/** A device credential returned once after browser approval. */
export type SiteDeviceGrant = z.infer<typeof issued>

/** Device transport configuration resolved by the account service. */
export interface SiteDeviceOptions {
  readonly origin: string
  readonly headers: Record<string, string>
  readonly requestTimeoutMs: number
}

/**
 * Read the public bootstrap using the configured origin rather than server-advertised addresses.
 * @param options - validated deployment and HTTP deadline.
 * @param signal - owning service lifetime.
 * @returns public branding fields.
 */
export async function readSiteBrand(options: SiteDeviceOptions, signal: AbortSignal): Promise<SiteBrand> {
  const result = bootstrap.parse(await request(options, '/api/client/v1/bootstrap', undefined, signal))
  if (result.logo) {
    const logo = new URL(result.logo, options.origin)
    if (logo.username || logo.password || (logo.protocol !== 'https:'
      && !(logo.origin === options.origin && logo.protocol === 'http:'))) throw new PlatformAuthError('protocol')
    result.logo = logo.href
  }
  return result
}

/**
 * Start and poll one verifier-bound website authorization; abort never admits a late credential.
 * @param options - validated deployment and HTTP deadline.
 * @param input - random verifier and non-secret device identity.
 * @param signal - attempt cancellation and absolute deadline.
 * @param waiting - publishes the browser URL and server expiry without the request secret.
 * @returns the issued relay API key and account identifier, never a dashboard access token.
 */
export async function authorizeSiteDevice(options: SiteDeviceOptions,
  input: { verifier: string; device_name: string; client_version: string }, signal: AbortSignal,
  waiting: (url: string, expiresAt: number) => void): Promise<SiteDeviceGrant> {
  const init = started.parse(await request(options, '/api/client/v1/device/authorize', input, signal))
  const url = new URL(init.approval_path, options.origin)
  if (url.origin !== options.origin || url.pathname !== '/device/approve' || url.username || url.password || url.hash
    || url.searchParams.getAll('authorization').length !== 1 || !url.searchParams.get('authorization')) {
    throw new PlatformAuthError('protocol')
  }
  const expiresAt = init.expires_at * 1000
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) throw new PlatformAuthError('expired')
  if (remaining > 2_147_483_647) throw new PlatformAuthError('protocol')
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(remaining)])
  lifetime.throwIfAborted()
  waiting(url.href, expiresAt)
  while (true) {
    await delay(init.interval_seconds * 1000, undefined, { signal: lifetime })
    const result = await request(options, '/api/client/v1/device/token', {
      request_secret: init.request_secret, verifier: input.verifier,
    }, lifetime)
    lifetime.throwIfAborted()
    if (result === pending) continue
    return issued.parse(result)
  }
}

const pending = Symbol('device-authorization-pending')

/** The configured site does not serve the requested device projection. */
export const siteEndpointUnavailable = Symbol('site-device-endpoint-unavailable')

async function request(options: SiteDeviceOptions, path: string, body: unknown, signal: AbortSignal, token?: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(new URL(path, options.origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...options.headers, 'content-type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]),
    })
  } catch (_transportFailure) { throw new PlatformAuthError('no-response') }
  if (token !== undefined && (response.status === 401 || response.status === 403)) {
    await response.body?.cancel()
    throw new AccountUnauthorizedError()
  }
  if (token !== undefined && response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return siteEndpointUnavailable
  }
  if (response.body === null) throw new PlatformAuthError('protocol')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 65_536) throw new PlatformAuthError('protocol')
      chunks.push(chunk.value)
    }
    const payload = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (path === '/api/client/v1/device/token' && response.status === 202 && !payload.success
      && payload.code === 'CLIENT_DEVICE_AUTHORIZATION_PENDING') return pending
    if (!response.ok || !payload.success) throw new PlatformAuthError('protocol')
    return payload.data
  } catch (error) {
    if (error instanceof PlatformAuthError) throw error
    throw new PlatformAuthError('protocol')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const amount = z.number().int()
const quota = z.object({ remain: amount, used: amount.nonnegative() })
const displaySettings = z.object({
  quota_per_unit: z.number().positive(), quota_display_type: z.string(), usd_exchange_rate: z.number().optional(),
  custom_currency_exchange_rate: z.number().optional(), custom_currency_symbol: z.string().optional(),
})

function readDisplaySettings(data: z.infer<typeof displaySettings>): SiteQuotaMetadata {
  return {
    quotaPerUnit: data.quota_per_unit, quotaDisplayType: data.quota_display_type,
    ...data.usd_exchange_rate === undefined ? {} : { usdExchangeRate: data.usd_exchange_rate },
    ...data.custom_currency_exchange_rate === undefined ? {} : { customCurrencyExchangeRate: data.custom_currency_exchange_rate },
    ...data.custom_currency_symbol === undefined ? {} : { customCurrencySymbol: data.custom_currency_symbol },
  }
}

const sessionData = z.object({
  user: z.object({ id: amount.positive(), username: z.string(), display_name: z.string(), email: z.string(), group: z.string() }),
  quota,
  token: z.object({ group: z.string(), effective_group: z.string() }),
  usable_groups: z.record(z.string(), z.unknown()),
  quota_metadata: displaySettings.optional(),
})
const billingData = z.object({ quota, quota_metadata: displaySettings.optional(), subscriptions: z.array(z.object({
  id: amount.positive(), plan_title: z.string(), plan_available: z.boolean(), status: z.string(),
  amount_total: amount.nonnegative(), amount_used: amount.nonnegative(), unlimited: z.boolean(),
  hour_quota_amount: amount.nonnegative(), hour_amount_used: amount.nonnegative(), hour_unlimited: z.boolean(),
  hour_window_seconds: amount.nonnegative(), quota_reset_period: z.string(), quota_reset_custom_seconds: amount.nonnegative().optional(),
  next_reset_time: amount.nonnegative(), end_time: amount.nonnegative(),
})) })

/** Read and validate device-authenticated profile and routing metadata.
 * @param options - configured issuer and deadline.
 * @param token - Host-only device key.
 * @param signal - credential lifetime.
 * @returns credential-free account fields, or the endpoint-unavailable marker on HTTP 404.
 */
export async function readSiteSession(options: SiteDeviceOptions, token: string, signal: AbortSignal):
Promise<SiteAccountSession | typeof siteEndpointUnavailable> {
  const payload = await request(options, '/api/client/v1/device/session', undefined, signal, token)
  if (payload === siteEndpointUnavailable) return siteEndpointUnavailable
  const data = sessionData.parse(payload)
  return { profile: { id: String(data.user.id) as AccountUserId, name: data.user.display_name || data.user.username,
    contact: data.user.email || null, avatarUrl: null }, username: data.user.username, group: data.user.group,
  deviceGroup: data.token.effective_group, usableGroups: Object.keys(data.usable_groups).sort(), quota: data.quota,
  ...data.quota_metadata === undefined ? {} : readDisplaySettings(data.quota_metadata) }
}

/** Read device-authenticated wallet quota and active subscriptions.
 * @param options - configured issuer and deadline.
 * @param token - Host-only device key.
 * @param signal - credential lifetime.
 * @returns wallet quota and subscriptions, or the endpoint-unavailable marker on HTTP 404.
 */
export async function readSiteBilling(options: SiteDeviceOptions, token: string, signal: AbortSignal):
Promise<SiteAccountBilling | typeof siteEndpointUnavailable> {
  const payload = await request(options, '/api/client/v1/device/billing', undefined, signal, token)
  if (payload === siteEndpointUnavailable) return siteEndpointUnavailable
  const data = billingData.parse(payload)
  return { quota: data.quota,
    ...data.quota_metadata === undefined ? {} : { quotaMetadata: readDisplaySettings(data.quota_metadata) },
    subscriptions: data.subscriptions.map(sub => ({
      id: String(sub.id), title: sub.plan_title,
      planAvailable: sub.plan_available, status: sub.status, total: sub.amount_total, used: sub.amount_used, unlimited: sub.unlimited,
      hourQuota: sub.hour_quota_amount, hourUsed: sub.hour_amount_used, hourUnlimited: sub.hour_unlimited,
      hourWindowSeconds: sub.hour_window_seconds, resetPeriod: sub.quota_reset_period,
      ...sub.quota_reset_custom_seconds === undefined ? {} : { resetCustomSeconds: sub.quota_reset_custom_seconds },
      nextResetTime: sub.next_reset_time, endTime: sub.end_time,
    })),
  }
}
