/** Requires desktop build artifacts; serves the standalone renderer without Electron. */
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { resolveDesktopLocale } from '../../desktop/src/locale.ts'
import type { WelcomeApi } from '../../desktop/src/welcome-api.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'

declare global {
  interface Window {
    dshWelcome: WelcomeApi
    desktopVisual: { publish(phase: 'waiting-browser' | 'failed' | 'expired'): void }
  }
}
const shots = '/tmp/harness-site-visual'
const longName = '星河人工智能开放平台 · 面向每一个开发者的超长品牌名称'

async function geometry(page: Page) {
  const boxes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
    '.altoai-brand,.site-brand,.site-brand-name,.tagline,.tagline h1,.tagline p,.auth-heading,.actions,button,.entry-error',
  )].filter(node => node.checkVisibility()).map((node) => {
    const box = node.getBoundingClientRect()
    return { name: node.id || node.className, x: box.x, right: box.right, y: box.y, bottom: box.bottom,
      center: (box.x + box.right) / 2, scroll: node.scrollWidth, width: node.clientWidth }
  }))
  for (const box of boxes) {
    expect(box.x, box.name).toBeGreaterThanOrEqual(0)
    expect(box.right, box.name).toBeLessThanOrEqual(600)
    expect(box.y, box.name).toBeGreaterThanOrEqual(0)
    expect(box.bottom, box.name).toBeLessThanOrEqual(700)
    expect(box.scroll, box.name).toBeLessThanOrEqual(box.width + 1)
    if (box.name.endsWith('-actions')) expect(box.center).toBe(300)
  }
  return boxes
}

it.each(['light', 'dark'] as const)('fits the desktop Welcome long brand, actions and focus in %s', async (scheme) => {
  const root = resolve(import.meta.dirname, '../../desktop')
  const server = createServer((req, res) => {
    const file = resolve(root, '.' + new URL(req.url ?? '/', 'http://fixture.local').pathname)
    if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return }
    void readFile(file).then((data) => {
      const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
      res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream')
      res.end(data)
    }, () => { res.writeHead(404).end() })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing desktop fixture listener')
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    await mkdir(shots, { recursive: true })
    for (const name of [longName, '星河 AI', 'UnbrokenWebsiteBrandName'.repeat(4), 'Altoai Harness']) {
      const context = await browser.newContext({ viewport: { width: 600, height: 700 }, colorScheme: scheme })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(({ locale, name }) => {
        const target = window
        let receive: ((state: AccountView) => void) | undefined
        let state: AccountView = { status: 'signed-out', attempt: null,
          links: { usageUrl: '', topUpUrl: '' }, brand: { name, logo: '', docsUrl: '' } }
        target.desktopVisual = { publish(phase) {
          state = { ...state, attempt: { id: 'visual-attempt' as NonNullable<AccountView['attempt']>['id'], phase } }
          receive?.(state)
        } }
        target.dshWelcome = { ...locale, analyticsEnabled: async () => false, takeNotice: async () => undefined,
          onAccountState(listener) { receive = listener; queueMicrotask(() => { listener(state) }); return () => { receive = undefined } },
          startSignIn: () => new Promise(() => {}),
          cancelSignIn: async () => { state = { ...state, attempt: null }; receive?.(state); return state },
          copySignInLink: async () => {}, skip: async () => { throw new Error('Unable to open workspace') } }
      }, { locale: resolveDesktopLocale('zh-CN', name === 'Altoai Harness' ? name : undefined), name })
      await page.goto(`http://127.0.0.1:${address.port}/renderer/welcome.html`)
      if (name === 'Altoai Harness') {
        await page.locator('.altoai-brand').waitFor()
        expect(await page.title()).toBe(name)
        await expect.poll(() => page.locator('.altoai-brand img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
        await page.evaluate(() => document.fonts.ready)
        await geometry(page)
        await page.screenshot({ path: `${shots}/altoai-welcome-${scheme}.png`, animations: 'disabled' })
        await context.close()
        continue
      }
      await page.locator('.site-brand-name').waitFor()
      expect(await page.locator('.site-brand-name').textContent()).toBe(name)
      await page.evaluate(() => document.fonts.ready)
      const capture = async (scene: string) => {
        const boxes = await geometry(page)
        if (name === longName) {
          console.log(scheme, scene, JSON.stringify(boxes))
          await page.screenshot({ path: `${shots}/desktop-${scheme}-${scene}.png`, animations: 'disabled' })
        }
      }
      expect(await page.title()).toBe(name)
      expect(await page.locator('img').count()).toBe(0)
      const background = await page.locator('#root').evaluate(node => getComputedStyle(node).backgroundColor)
      expect(background).toBe(scheme === 'dark' ? 'rgb(8, 12, 22)' : 'rgb(244, 246, 251)')
      await page.keyboard.press('Tab')
      expect(await page.locator('#sign-in').evaluate(node => node.matches(':focus-visible'))).toBe(true)
      expect(await page.locator('#entry-actions button:visible').count()).toBe(2)
      await capture('entry-focus')
      const heading = await page.locator('#welcome-heading').boundingBox()
      if (name === '星河 AI') expect(heading!.height).toBeLessThanOrEqual(42)
      else expect(heading!.height).toBeGreaterThan(42)
      await page.locator('#sign-in').click()
      await expect.poll(() => page.locator('#auth-cancel').isDisabled()).toBe(true)
      await capture('login-starting')
      await page.evaluate(() => { window.desktopVisual.publish('waiting-browser') })
      await expect.poll(() => page.locator('#auth-copy').isVisible()).toBe(true)
      await capture('login-waiting')
      await page.locator('#auth-copy').click()
      await expect.poll(() => page.locator('#auth-copy').isDisabled()).toBe(true)
      await capture('login-copied')
      await page.evaluate(() => { window.desktopVisual.publish('failed') })
      await expect.poll(() => page.locator('#auth-retry').isVisible()).toBe(true)
      await capture('login-error')
      await page.evaluate(() => { window.desktopVisual.publish('expired') })
      await expect.poll(() => page.locator('#auth-description').isVisible()).toBe(true)
      await capture('login-expired')
      expect(await page.locator('#auth-actions button:visible').count()).toBe(1)
      await page.locator('#auth-retry').click()
      await page.evaluate(() => { window.desktopVisual.publish('waiting-browser') })
      await page.locator('#auth-cancel').click()
      await expect.poll(() => page.locator('#sign-in').isVisible()).toBe(true)
      await capture('entry-return')
      await page.locator('#skip-login').click()
      await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true)
      await capture('entry-skip-error')
      expect(errors).toEqual([])
      await context.close()
    }
  } finally {
    await browser?.close()
    await new Promise<void>((done, reject) => {
      server.close((error) => { if (error) reject(error); else done() })
      server.closeAllConnections()
    })
  }
})
