/** Website deployment rendered through the real Web host, RPC, account service and browser plugins. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, revealNavigationDrawer } from './support.ts'

import type { DeepSeekAccount } from '../../../packages/account/deepseek-account/src/index.ts'

const BRAND = '星河人工智能开放平台 · 面向每一个开发者的超长品牌名称'
const SHOTS = '/tmp/harness-site-data-visual'

async function externalSite() {
  let fail = true
  let approved = false
  let sessionFailure = false
  let billingFailure = false
  let variant: 'subscriptions' | 'missing' = 'subscriptions'
  const requests: { path: string; authorization: string | undefined }[] = []
  const quotaMetadata = { unit: 'quota', quota_per_unit: 500000, quota_display_type: 'USD' }
  const subscriptions = [
    { id: 101, plan_id: 1, plan_title: '星河专业月度套餐', plan_available: true, status: 'active',
      amount_total: 5000000, amount_used: 1250000, unlimited: false, hour_quota_amount: 500000,
      hour_amount_used: 125000, hour_unlimited: false, hour_window_seconds: 3600,
      quota_reset_period: 'daily', next_reset_time: 1893542400, end_time: 1896134400 },
    { id: 102, plan_id: 2, plan_title: '无限探索套餐', plan_available: true, status: 'active',
      amount_total: 0, amount_used: 12500000, unlimited: true, hour_quota_amount: 0,
      hour_amount_used: 500000, hour_unlimited: true, hour_window_seconds: 3600,
      quota_reset_period: 'never', next_reset_time: 0, end_time: 1896134400 },
    { id: 103, plan_id: 3, plan_title: '历史过期套餐', plan_available: true, status: 'expired',
      amount_total: 1000000, amount_used: 1000000, unlimited: false, hour_quota_amount: 100000,
      hour_amount_used: 0, hour_unlimited: false, hour_window_seconds: 3600,
      quota_reset_period: 'daily', next_reset_time: 0, end_time: 1609459200 },
    { id: 104, plan_id: 404, plan_title: '', plan_available: false, status: 'active',
      amount_total: 2000000, amount_used: 250000, unlimited: false, hour_quota_amount: 0,
      hour_amount_used: 0, hour_unlimited: true, hour_window_seconds: 0,
      quota_reset_period: '', next_reset_time: 0, end_time: 1896134400 },
  ]
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture.local').pathname
    res.setHeader('content-type', 'application/json')
    const reply = (data: object) => res.end(JSON.stringify({ success: true, data }))
    requests.push({ path, authorization: req.headers.authorization })
    if (path === '/api/client/v1/device/session' || path === '/api/client/v1/device/billing') {
      if (req.headers.authorization !== 'Bearer sk-site-visual-fixture') {
        res.statusCode = 401; return res.end(JSON.stringify({ success: false }))
      }
      if (path.endsWith('/session')) {
        if (sessionFailure) { res.statusCode = 503; return res.end(JSON.stringify({ success: false })) }
        return reply({ api_version: 1,
          user: { id: 42, username: 'starlight_dev', display_name: '星河开发者', email: 'developer@example.test',
            role: 1, status: 1, group: 'professional' },
          device: { id: 7, name: 'Visual fixture' },
          token: { id: 8, name: 'Visual fixture', group: 'routing-premium', effective_group: 'routing-premium',
            unlimited_quota: true, remain_quota: 0, used_quota: 1500000, expired_time: -1 },
          usable_groups: { professional: '专业用户组', 'routing-premium': '高级路由组' },
          quota: { remain: 12500000, used: 1500000, request_count: 321 }, quota_metadata: quotaMetadata })
      }
      if (billingFailure) { res.statusCode = 503; return res.end(JSON.stringify({ success: false })) }
      return reply({ api_version: 1, billing_preference: 'subscription_first', quota_metadata: quotaMetadata,
        quota: { remain: 12500000, used: 1500000 }, subscriptions: variant === 'missing' ? [] : subscriptions,
        plans: [], topup: { enabled: true, redemption_enabled: true, min_topup: 1, amount_options: [],
          web_wallet_path: '/wallet', web_subscription_path: '/wallet#subscription-plans' } })
    }
    if (path === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: [] }))
    if (path === '/api/client/v1/bootstrap') return reply({
      api_version: 1, system_name: BRAND, logo: '', docs_link: '', version: 'visual-test',
    })
    if (path === '/api/client/v1/device/authorize') {
      if (fail) { res.statusCode = 503; return res.end(JSON.stringify({ success: false })) }
      return reply({ request_secret: 'fixture-secret', approval_path: '/device/approve?authorization=fixture',
        expires_at: Math.floor(Date.now() / 1000) + 120, interval_seconds: 0.05 })
    }
    if (path === '/api/client/v1/device/token') {
      if (!approved) { res.statusCode = 202; return res.end(JSON.stringify({ success: false, code: 'CLIENT_DEVICE_AUTHORIZATION_PENDING' })) }
      return reply({ api_key: 'sk-site-visual-fixture', user_id: 42, device_name: 'Visual fixture' })
    }
    if (path === '/device/approve') { approved = true; return reply({ approved: true }) }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
  }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture listener')
  return { origin: `http://127.0.0.1:${address.port}`, requests,
    allowSignIn: () => { fail = false },
    failSession: (value: boolean) => { sessionFailure = value },
    failBilling: (value: boolean) => { billingFailure = value },
    setVariant: (value: typeof variant) => { variant = value },
  }
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
}

async function shot(page: Page, name: string) {
  await noOverflow(page)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' })
}

async function colors(control: Locator) {
  return control.evaluate((node) => {
    const style = getComputedStyle(node)
    return { foreground: style.color, background: style.backgroundColor }
  })
}

async function palette(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(scheme === 'dark')
  const semantic = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.cssText = 'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)'
    document.body.append(probe)
    const style = getComputedStyle(probe)
    const result = { background: style.backgroundColor, foreground: style.color }
    probe.remove()
    return result
  })
  expect(semantic.background).toBe(scheme === 'dark' ? 'rgb(8, 12, 22)' : 'rgb(244, 246, 251)')
  expect(semantic.foreground).toBe(scheme === 'dark' ? 'rgb(241, 245, 249)' : 'rgb(15, 23, 42)')
}

it('renders website branding, both palettes, narrow focus and account sign-in/out through the shipped Web composition', async () => {
  const site = await externalSite()
  const root = await mkdtemp(join(tmpdir(), 'dsh-site-visual-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'site.overlay.yml')
  await writeFile(overlay, `- id: deepseek-account\n  config:\n    authProtocol: site-device\n    platformOrigin: ${site.origin}\n    inferenceOrigin: ${site.origin}\n    allowLoopbackHttp: true\n`)
  await mkdir(SHOTS, { recursive: true })
  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const account = scaffold.ctx.get('deepseekAccount') as DeepSeekAccount
  const browser = await chromium.launch({ headless: true })
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE,
    colorScheme: 'light', reducedMotion: 'reduce' })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(SHOTS, 'web-last-state.png'), fullPage: true })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  expect((await account.getState()).brand?.name).toBe(BRAND)
  await expect.poll(() => page.title(), { timeout: 10_000 }).toContain(BRAND)
  const menu = page.getByRole('button', { name: '账号菜单', exact: true })
  await menu.waitFor()
  for (const scheme of ['light', 'dark'] as const) {
    await palette(page, scheme)
    await shot(page, `web-workbench-${scheme}`)
    await menu.click()
    await page.getByRole('menuitem', { name: '登录', exact: true }).click()
    const failure = page.getByRole('dialog', { name: '登录失败', exact: true })
    await failure.waitFor()
    const retry = failure.getByRole('button', { name: '重新登录', exact: true })
    const pair = await colors(retry)
    expect(pair.foreground).toBe('rgb(255, 255, 255)')
    expect(pair.background).toBe(scheme === 'dark' ? 'rgb(59, 130, 246)' : 'rgb(37, 99, 235)')
    await shot(page, `web-login-error-${scheme}`)
    await page.setViewportSize({ width: 390, height: 844 })
    await retry.focus()
    await page.keyboard.press('Tab')
    expect(await failure.evaluate(node => node.contains(document.activeElement))).toBe(true)
    await retry.focus()
    await shot(page, `web-login-narrow-focus-${scheme}`)
    await failure.getByRole('button', { name: '关闭', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  site.allowSignIn()
  await menu.click()
  const popup = page.waitForEvent('popup')
  await page.getByRole('menuitem', { name: '登录', exact: true }).click()
  const approval = await popup
  await approval.waitForURL(url => url.origin === site.origin && url.pathname === '/device/approve')
  await expect.poll(async () => (await account.getState()).status).toBe('credential-stored')
  await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
  for (const scheme of ['light', 'dark'] as const) {
    await palette(page, scheme)
    await menu.click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).waitFor()
    await shot(page, `web-account-menu-${scheme}`)
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '账号与余额', exact: true }).click()
    const accountInfo = page.getByRole('link', { name: '更多账号信息', exact: true })
    await accountInfo.waitFor()
    expect(await accountInfo.getAttribute('href')).toBe(`${site.origin}/`)
    expect((await account.getState()).links.topUpUrl).toBe(`${site.origin}/wallet`)
    await expect.poll(() => settings.innerText()).toContain('星河开发者')
    await expect.poll(() => settings.innerText()).toContain('developer@example.test')
    await expect.poll(() => settings.innerText()).toContain('starlight_dev')
    await expect.poll(() => settings.innerText()).toContain('professional')
    await expect.poll(() => settings.innerText()).toContain('routing-premium')
    for (const title of ['星河专业月度套餐', '无限探索套餐', '历史过期套餐']) {
      await expect.poll(() => settings.innerText()).toContain(title)
    }
    for (const value of ['$25', '$3', '$2.5 / $10 · 剩余额度 $7.5',
      '$0.25 / $1 · 剩余额度 $0.75 · 1小时', '每日', '无限制', '套餐资料暂不可用']) {
      expect(await settings.innerText()).toContain(value)
    }
    expect(await settings.getByRole('link', { name: '管理钱包', exact: true }).getAttribute('href')).toBe(`${site.origin}/wallet`)
    expect(await settings.innerText()).not.toContain('sk-site-visual-fixture')
    await shot(page, `web-account-${scheme}`)
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await revealNavigationDrawer(page, 'zh')
  await shot(page, 'web-brand-long-no-logo-narrow')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await menu.click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '退出登录', exact: true }).click()
  await expect.poll(async () => (await account.getState()).status).toBe('signed-out')
  expect(errors).toEqual([])
})


it('renders the real signed-in welcome flow in light and dark with a long site name', async () => {
  const site = await externalSite()
  site.allowSignIn()
  const root = await mkdtemp(join(tmpdir(), 'dsh-site-welcome-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'site.overlay.yml')
  await writeFile(overlay, `- id: deepseek-account\n  config:\n    authProtocol: site-device\n    platformOrigin: ${site.origin}\n    inferenceOrigin: ${site.origin}\n    allowLoopbackHttp: true\n`)
  await mkdir(SHOTS, { recursive: true })
  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const account = scaffold.ctx.get('deepseekAccount') as DeepSeekAccount
  await account.startSignIn({ version: 'visual-test', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }, scaffold.baseUrl, 'web')
  await expect.poll(async () => (await account.getState()).attempt?.phase).toBe('waiting-browser')
  await fetch(`${site.origin}/device/approve?authorization=fixture`)
  await expect.poll(async () => (await account.getState()).status).toBe('credential-stored')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE,
    colorScheme: 'light', reducedMotion: 'reduce' })
  await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[data-desktop-onboarding="welcome"]').waitFor()
  expect(await page.getByRole('heading', { level: 1 }).innerText()).toContain(BRAND)
  for (const scheme of ['light', 'dark'] as const) {
    await palette(page, scheme)
    await shot(page, `web-welcome-${scheme}`)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(page, `web-welcome-narrow-${scheme}`)
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
})


it('renders independent site profile and billing failures, retry recovery and missing subscriptions in both palettes', async () => {
  const site = await externalSite()
  site.allowSignIn()
  const root = await mkdtemp(join(tmpdir(), 'dsh-site-data-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'site.overlay.yml')
  await writeFile(overlay, `- id: deepseek-account\n  config:\n    authProtocol: site-device\n    platformOrigin: ${site.origin}\n    inferenceOrigin: ${site.origin}\n    allowLoopbackHttp: true\n`)
  await mkdir(SHOTS, { recursive: true })
  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const account = scaffold.ctx.get('deepseekAccount') as DeepSeekAccount
  await account.startSignIn({ version: 'visual-test', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }, scaffold.baseUrl, 'web')
  await expect.poll(async () => (await account.getState()).attempt?.phase).toBe('waiting-browser')
  await fetch(`${site.origin}/device/approve?authorization=fixture`)
  await expect.poll(async () => (await account.getState()).status).toBe('credential-stored')
  const browser = await chromium.launch({ headless: true })
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE,
    colorScheme: 'light', reducedMotion: 'reduce' })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(SHOTS, 'web-site-data-last-state.png'), fullPage: true })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const openAccount = async () => {
    await page.getByRole('button', { name: '账号菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '账号与余额', exact: true }).click()
    return settings
  }
  for (const scheme of ['light', 'dark'] as const) {
    await palette(page, scheme)
    site.failSession(false)
    site.failBilling(true)
    let settings = await openAccount()
    await expect.poll(() => settings.innerText()).toContain('星河开发者')
    await expect.poll(() => settings.getByRole('alert').count()).toBeGreaterThan(0)
    await shot(page, `web-site-billing-error-${scheme}`)
    const failedBillingReads = site.requests.filter(request => request.path.endsWith('/device/billing')).length
    site.failBilling(false)
    await settings.getByRole('button', { name: /重试|刷新/ }).first().click()
    await expect.poll(() => settings.innerText()).toContain('星河专业月度套餐')
    await expect.poll(() => settings.getByRole('alert').count()).toBe(0)
    expect(site.requests.filter(request => request.path.endsWith('/device/billing')).length).toBeGreaterThan(failedBillingReads)
    await shot(page, `web-site-billing-recovered-${scheme}`)
    await page.keyboard.press('Escape')

    site.failSession(true)
    settings = await openAccount()
    await expect.poll(() => settings.innerText()).toContain('星河专业月度套餐')
    await expect.poll(() => settings.getByRole('alert').count()).toBeGreaterThan(0)
    await shot(page, `web-site-profile-error-${scheme}`)
    site.failSession(false)
    await settings.getByRole('button', { name: /重试|刷新/ }).first().click()
    await expect.poll(() => settings.innerText()).toContain('starlight_dev')
    await expect.poll(() => settings.getByRole('alert').count()).toBe(0)
    await shot(page, `web-site-profile-recovered-${scheme}`)
    await page.keyboard.press('Escape')

    site.setVariant('missing')
    settings = await openAccount()
    await expect.poll(() => settings.innerText()).toContain('暂无生效订阅')
    expect(await settings.innerText()).not.toContain('星河专业月度套餐')
    await expect.poll(() => settings.innerText()).toContain('星河开发者')
    await shot(page, `web-site-no-subscriptions-${scheme}`)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(page, `web-site-no-subscriptions-narrow-${scheme}`)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 1000 })
    site.setVariant('subscriptions')
  }
  const detailRequests = site.requests.filter(request => /\/device\/(session|billing)$/.test(request.path))
  expect(detailRequests.length).toBeGreaterThan(0)
  expect(detailRequests.every(request => request.authorization === 'Bearer sk-site-visual-fixture')).toBe(true)
  expect(site.requests.some(request => request.path === '/api/user/self')).toBe(false)
  expect(errors).toEqual([])
})
