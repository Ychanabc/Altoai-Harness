// Web e2e scenario: the real skill-load recording, seeded cold through the
// persistence seam, renders through ui-skill's keyed toolview without a model
// call. The disclosure proves replay-stable naming and exact durable output.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { startWorkspaceSshServer } from '../../../packages/workspace/workspace/tests/fixtures/ssh-server.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, openSettings, saveFailureShot } from './support.ts'

// Any generation path names the role; the owner's highest committed generation replays.
const FIXTURE = fileURLToPath(new URL('../../../snapshots/session/skill-load/session.v4.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/skill-tool-row', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/skill-tool-row/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'skill-tool-row-web-e2e'
const PROMPT = 'Load the editing-cordis-compositions skill with the skill tool, then reply DONE.'

describe.skipIf(MODE === 'record')('web e2e: dedicated Skill tool row', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(await selectedSessionFixture(FIXTURE), 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    const skillRow = page.locator('[data-tool="skill"]')
    await expandOwningTurnProcess(page, skillRow)
    await skillRow.waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('expands the loaded skill to its exact recorded instructions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-tool-row'))
    const call = page.locator('[data-tool="skill"]')
    const row = call.getByRole('button', { name: 'Skill editing-cordis-compositions' })
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    expect(await call.getByText('editing-cordis-compositions', { exact: true }).count()).toBe(1)

    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    await call.getByText('Instructions', { exact: true }).waitFor()
    const output = call.locator('pre')
    await output.waitFor()
    expect(await output.textContent()).toContain('<skill_content name="editing-cordis-compositions">')
    expect(await output.textContent()).toContain('Agent presets are ordinary `@deepseek-ai/dsh-agent-preset` declarations carried by bundle patches.')
    expect(await output.evaluate(element => getComputedStyle(element.parentElement!).maxHeight)).toBe('260px')

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(JSON.stringify(scaffold.workspaceCwd).slice(1, -1)).join('{{cwd}}')
      .replace(/\b\d{1,2}\/\d{1,2}(?= \{\{clock\}\})/g, '{{date}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the collapsed Skill line on the global ToolCall font-size axis', async () => {
    const call = page.locator('[data-tool="skill"]')
    const toggle = call.getByRole('button', { name: 'Skill editing-cordis-compositions' })
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    const row = call.locator(':scope > div').first()
    const title = call.getByText('Skill', { exact: true })
    const summary = call.getByText('editing-cordis-compositions', { exact: true })

    expect(await title.evaluate(element => getComputedStyle(element).fontSize)).toBe('13px')

    const previous = await page.evaluate(() => ({
      fontSize: {
        value: document.body.style.getPropertyValue('--dsh-content-font-size-secondary'),
        priority: document.body.style.getPropertyPriority('--dsh-content-font-size-secondary'),
      },
      delta: {
        value: document.body.style.getPropertyValue('--dsh-content-font-delta'),
        priority: document.body.style.getPropertyPriority('--dsh-content-font-delta'),
      },
    }))
    await page.evaluate(() => {
      document.body.style.setProperty('--dsh-content-font-size-secondary', '15px')
      document.body.style.setProperty('--dsh-content-font-delta', '2px')
    })
    try {
      expect(await title.evaluate(element => getComputedStyle(element).fontSize)).toBe('15px')
      expect(await summary.evaluate(element => getComputedStyle(element).fontSize)).toBe('15px')
      expect(await row.evaluate(element => getComputedStyle(element).height)).toBe('26px')
      expect(await row.locator('svg').first().evaluate(element => getComputedStyle(element).width)).toBe('16px')
    } finally {
      await page.evaluate((saved) => {
        const restore = (name: string, entry: { value: string; priority: string }): void => {
          if (entry.value === '') document.body.style.removeProperty(name)
          else document.body.style.setProperty(name, entry.value, entry.priority)
        }
        restore('--dsh-content-font-size-secondary', saved.fontSize)
        restore('--dsh-content-font-delta', saved.delta)
      }, previous)
    }
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })

  it('keeps the conversation at its final width while either sidebar animates', async () => {
    for (const name of ['Collapse sidebar', 'Open sidebar', 'Open right sidebar', 'Collapse right sidebar']) {
      const control = page.getByRole('button', { name, exact: true })
      const widths = await control.evaluate(async (element) => {
        if (!(element instanceof HTMLButtonElement)) throw new Error('Expected a sidebar toggle button')
        const frame = element.closest<HTMLElement>('[class*="frame"]')!
        const content = frame.querySelector<HTMLElement>('[class*="centerContent"]')!
        const column = content.parentElement!
        const before = content.getBoundingClientRect().width
        const samples: { content: number; column: number }[] = []
        element.click()
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await new Promise<number>((resolve) => { requestAnimationFrame(resolve) })
          if (frame.hasAttribute('data-animating')) {
            samples.push({ content: content.getBoundingClientRect().width, column: column.getBoundingClientRect().width })
          } else if (samples.length > 0) {
            break
          }
        }
        return { before, after: content.getBoundingClientRect().width, samples }
      })
      expect(widths.after).not.toBe(widths.before)
      expect(widths.samples.some(sample => Math.abs(sample.column - sample.content) > 1)).toBe(true)
      expect(widths.samples.every(sample => Math.abs(sample.content - widths.after) < 1)).toBe(true)
    }
  })

  it('opens the skill library from navigation and refreshes the official catalog', async () => {
    let requests = 0
    await page.route('https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1', async (route) => {
      requests += 1
      await route.fulfill({
        json: { tree: [
          { type: 'blob', path: 'skills/docx/SKILL.md' },
          { type: 'blob', path: `skills/${requests === 1 ? 'pdf' : 'pptx'}/SKILL.md` },
          { type: 'blob', path: 'skills/README.md' },
        ] },
      })
    })
    const navigation = page.getByRole('button', { name: 'Skill Library', exact: true })
    const plugins = page.getByRole('button', { name: 'Plugins', exact: true })
    const pluginButton = await plugins.elementHandle()
    expect(await navigation.evaluate((entry, other) => other !== null && Boolean(
      other.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ), pluginButton)).toBe(true)
    await navigation.click()
    await page.getByRole('heading', { name: 'Skill Library' }).waitFor()
    const pdf = page.getByRole('link', { name: 'pdf', exact: true })
    await pdf.waitFor()
    expect(await pdf.getAttribute('href')).toBe('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md')
    expect(await pdf.locator('svg').count()).toBe(2)
    expect(await pdf.evaluate((card) => {
      const list = card.closest('ul')
      return list === null ? null : getComputedStyle(list).display
    })).toBe('grid')
    const search = page.getByRole('searchbox', { name: 'Search skills' })
    await search.fill('docx')
    await pdf.waitFor({ state: 'hidden' })
    await search.fill('')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('link', { name: 'pptx', exact: true }).waitFor()
    await pdf.waitFor({ state: 'hidden' })
    expect(await page.getByRole('link', { name: 'README.md', exact: true }).count()).toBe(0)
  })

  it('keeps appearance in Settings and creates and persists a session in an SSH workspace', async () => {
    expect(await page.getByRole('button', { name: /switch to (dark|light)/iu }).count()).toBe(0)
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    const dark = settings.getByRole('button', { name: 'Dark', exact: true })
    await dark.click()
    await expect.poll(() => dark.getAttribute('aria-pressed')).toBe('true')

    const ssh = settings.getByRole('group', { name: 'SSH remote service' })
    const submit = ssh.getByRole('button', { name: 'Add as workspace' })
    expect(await submit.isEnabled()).toBe(false)
    expect(await ssh.getByLabel('Port', { exact: true }).inputValue()).toBe('22')
    await ssh.getByLabel('IP address').fill('invalid-address')
    await ssh.getByLabel('Username').fill('project')
    const password = ssh.getByLabel('Password', { exact: true })
    await password.fill('test password')
    await ssh.getByLabel('Remote workspace path').fill('/remote/project')
    await submit.click()
    await expect.poll(() => ssh.getByRole('alert').textContent()).toContain('valid SSH IP address')
    expect(await password.inputValue()).toBe('')

    const { connection, directory, close } = await startWorkspaceSshServer()
    try {
      await ssh.getByLabel('IP address').fill(connection.host)
      await ssh.getByLabel('Port', { exact: true }).fill(String(connection.port))
      await ssh.getByLabel('Username').fill(connection.username)
      await password.fill(connection.password)
      await ssh.getByLabel('Remote workspace path').fill(directory)
      await submit.click()
      await ssh.getByRole('status').filter({ hasText: 'SSH workspace added' }).waitFor()
      expect(await password.inputValue()).toBe('')
      const path = `ssh://${connection.username}@${connection.host}:${connection.port}${directory}`
      const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(path)
      expect(workspace?.path).toBe(path)
      await expect(workspace?.status()).resolves.toBe('ok')
      await settings.getByRole('button', { name: 'Close', exact: true }).click()
      const title = page.getByText('project folder', { exact: true })
      await title.hover()
      const created = page.waitForResponse('**/api/session/create')
      await page.getByRole('button', { name: 'New session in project folder', exact: true }).click()
      const response = await created
      const body = await response.json() as { result: { ok: true; value: { sessionId: SessionId } } | { ok: false } }
      expect(body.result).toMatchObject({ ok: true, value: { sessionId: expect.any(String) } })
      if (!body.result.ok) throw new Error('Session creation failed')
      const { sessionId } = body.result.value
      expect(workspace?.sessionIds).toContain(sessionId)
      await expect(scaffold.ctx.sessionPersistence.stat(sessionId)).resolves.toMatchObject({
        header: { cwd: path },
        formatStatus: 'current',
      })
    } finally {
      await close()
    }
  })
})
