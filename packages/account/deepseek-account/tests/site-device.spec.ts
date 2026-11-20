/** Website protocol behavior without real accounts or credentials. */
import { afterEach, expect, it, vi } from 'vitest'
import { authorizeSiteDevice, readSiteBrand, readSiteSession, readSiteBilling } from '../src/site-device.ts'

const options = { origin: 'https://site.invalid', headers: {}, requestTimeoutMs: 1000 }
const input = { verifier: 'v'.repeat(43), device_name: 'Harness test', client_version: 'test' }
afterEach(() => { vi.unstubAllGlobals() })
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status })
const init = (approval_path = '/device/approve?authorization=public-id') => ({
  request_secret: 'synthetic-request-secret', approval_path, expires_at: Math.floor(Date.now() / 1000) + 60, interval_seconds: 0.001,
})

it('reads public bootstrap branding', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ api_version: 1, system_name: 'Test site', logo: '/logo.png', docs_link: '', version: 'test' })))
  expect(await readSiteBrand(options, new AbortController().signal)).toMatchObject({ system_name: 'Test site' })
})

it('does not treat missing bootstrap as a device projection diagnosis', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
  await expect(readSiteBrand(options, new AbortController().signal)).rejects.toMatchObject({ code: 'protocol' })
})

it('polls pending authorization and keeps verifier and request secret out of the public URL', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(init()))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, code: 'CLIENT_DEVICE_AUTHORIZATION_PENDING' }), { status: 202 }))
    .mockResolvedValueOnce(reply({ api_key: 'synthetic-key', user_id: 7, device_name: input.device_name }))
  vi.stubGlobal('fetch', fetcher)
  const waiting = vi.fn()
  expect(await authorizeSiteDevice(options, input, new AbortController().signal, waiting)).toMatchObject({ api_key: 'synthetic-key', user_id: 7 })
  expect(waiting.mock.calls[0]?.[0]).toBe('https://site.invalid/device/approve?authorization=public-id')
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error', body: JSON.stringify({ request_secret: 'synthetic-request-secret', verifier: input.verifier }) })
})

it.each(['https://other.invalid/device/approve?authorization=id', '/wrong?authorization=id', '/device/approve?authorization=id#fragment'])(
  'rejects unsafe approval destination %s', async (path) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(init(path))))
    await expect(authorizeSiteDevice(options, input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'protocol' })
  })

it('does not return a late token after local cancellation', async () => {
  const lifetime = new AbortController()
  const fetcher = vi.fn().mockResolvedValueOnce(reply(init())).mockImplementationOnce(async () => {
    lifetime.abort()
    return reply({ api_key: 'synthetic-late-key', user_id: 7, device_name: 'test' })
  })
  vi.stubGlobal('fetch', fetcher)
  await expect(authorizeSiteDevice(options, input, lifetime.signal, vi.fn())).rejects.toThrow()
})

it('rejects denied authorization instead of continuing to poll', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(init())).mockResolvedValueOnce(
    new Response(JSON.stringify({ success: false, code: 'CLIENT_DEVICE_AUTHORIZATION_DENIED' }), { status: 403 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(authorizeSiteDevice(options, input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'protocol' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

const session = {
  user: { id: 7, username: 'real-user', display_name: 'Real User', email: 'user@example.test', group: 'vip' },
  token: { group: '', effective_group: 'vip', key: 'must-not-leak' }, usable_groups: { vip: { ratio: 1 }, auto: {} },
  quota: { remain: 500000, used: 12 }, quota_metadata: { quota_per_unit: 500000, quota_display_type: 'USD' },
}
it('projects only safe session fields and authenticates with the device key', async () => {
  const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => reply(session))
  vi.stubGlobal('fetch', fetcher)
  const result = await readSiteSession(options, 'synthetic-key', new AbortController().signal)
  expect(result).toMatchObject({ profile: { name: 'Real User', contact: 'user@example.test' }, group: 'vip', deviceGroup: 'vip', usableGroups: ['auto', 'vip'] })
  expect(JSON.stringify(result)).not.toContain('must-not-leak')
  expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://site.invalid/api/client/v1/device/session')
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer synthetic-key' }, redirect: 'error' })
})
it.each([401, 403])('classifies HTTP %s as credential expiry even without a JSON body', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status })))
  await expect(readSiteSession(options, 'key', new AbortController().signal)).rejects.toMatchObject({ code: 'expired' })
})
it('rejects imprecise raw quota', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ ...session, quota: { remain: Number.MAX_SAFE_INTEGER + 1, used: 0 } })))
  await expect(readSiteSession(options, 'key', new AbortController().signal)).rejects.toThrow()
})
it('accepts older session and billing responses with no display metadata', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...session, quota_metadata: undefined }))
    .mockResolvedValueOnce(reply({ quota: { remain: 500001, used: 12 }, subscriptions: [] })))
  const signal = new AbortController().signal
  const profile = await readSiteSession(options, 'key', signal)
  expect(profile).toMatchObject({ username: 'real-user', quota: { remain: 500000, used: 12 } })
  expect(profile).not.toHaveProperty('quotaPerUnit')
  expect(await readSiteBilling(options, 'key', signal)).toEqual({ quota: { remain: 500001, used: 12 }, subscriptions: [] })
})
it('keeps wallet quota separate from unlimited subscriptions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ quota: { remain: 25, used: 90 }, quota_metadata: { quota_per_unit: 400000.5, quota_display_type: 'CUSTOM',
    usd_exchange_rate: 7.25, custom_currency_exchange_rate: 3.625, custom_currency_symbol: 'Cr' }, subscriptions: [{ id: 1,
    plan_title: 'Actual plan', plan_available: true, status: 'active', amount_total: 0, amount_used: 10, unlimited: true,
    hour_quota_amount: 100, hour_amount_used: 20, hour_unlimited: false, hour_window_seconds: 3600,
    quota_reset_period: 'custom', quota_reset_custom_seconds: 5400, next_reset_time: 1800000000, end_time: 1900000000 }] })))
  expect(await readSiteBilling(options, 'key', new AbortController().signal)).toMatchObject({ quota: { remain: 25 },
    quotaMetadata: { quotaPerUnit: 400000.5, quotaDisplayType: 'CUSTOM', usdExchangeRate: 7.25, customCurrencyExchangeRate: 3.625, customCurrencySymbol: 'Cr' },
    subscriptions: [{ id: '1', title: 'Actual plan', unlimited: true, hourQuota: 100, hourUsed: 20, resetCustomSeconds: 5400 }] })
})
