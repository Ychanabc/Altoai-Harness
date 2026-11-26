/** Both GUI profiles receive the site deployment through their shared Web bundle. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createPluginProfile } from '../../../../apps/desktop/src/project-manager.ts'
import { expect, it } from 'vitest'
import { z } from 'zod'

it('ships the site overlay last and retains Desktop platform identity', () => {
  const manifest = z.object({ dsh: z.object({ bundle: z.object({ patch: z.array(z.string()) }) }),
    files: z.array(z.string()) }).parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))
  expect(manifest.dsh.bundle.patch.at(-1)).toBe('./site.overlay.yml')
  expect(manifest.files).toContain('site.overlay.yml')
  const overlay = readFileSync(new URL('../site.overlay.yml', import.meta.url), 'utf8')
  expect(overlay).toContain('authProtocol: site-device')
  expect(overlay).toContain('catalogProtocol: site')
  expect(overlay).toContain("ctx.get('profileContext')?.name === 'desktop'")
  expect(overlay).toContain("['darwin', 'win32'].includes(process.platform) ? process.platform : null")
})

it('composes the real Desktop profile with site authorization and account-managed compatible model routes', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-site-profile-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const profile = loadProfileDirectory('dsh desktop', profileDir,
      fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url)))
    const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
    expect(rows.find(row => row.id === 'deepseek-account')?.config).toMatchObject({
      authProtocol: 'site-device', platformOrigin: 'https://ai.vpss.eu.cc', inferenceOrigin: 'https://ai.vpss.eu.cc',
    })
    expect(rows.find(row => row.id === 'llm-deepseek-account')?.config).toMatchObject({
      baseURL: 'https://ai.vpss.eu.cc', catalogProtocol: 'site',
    })
    expect(rows.find(row => row.id === 'llm-deepseek-account')?.config).not.toHaveProperty('thinking')
    expect(rows.find(row => row.id === 'llm-deepseek-account')?.config).not.toHaveProperty('reasoningEffort')
    expect(rows.find(row => row.id === 'ui-model-selection')?.config).toMatchObject({ officialProvider: 'deepseek-account' })
    expect(rows.find(row => row.id === 'ui-settings-models')?.config).toMatchObject({ officialProvider: 'deepseek-account' })
    expect(rows.find(row => row.id === 'agent-default-model')?.config).toMatchObject({ provider: 'deepseek-account' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it.each([
  { profileName: 'desktop', args: ['--no-open'], active: true },
  { profileName: 'web', args: ['--no-open', '--ssh-model-relay'], active: false },
])('selects native model plugins before web startup in the $profileName profile', async ({ args, active }) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-site-model-rows-'))
  const ctx = new Context()
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const profile = loadProfileDirectory('dsh desktop', profileDir,
      fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url)))
    const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
    const modelIds = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']
    const activated: string[] = []
    provideCmdline(ctx, { args, exit: () => {} })
    await ctx.plugin(Loader).await()
    ctx.loader.builtins.testModelPlugin = {
      apply(entry: Context) { activated.push(entry.fiber.entry!.options.id) },
    }
    await ctx.loader.root.update(rows.filter(row => modelIds.includes(row.id))
      .map(row => ({ ...row, name: 'cordis:testModelPlugin' })))
    await ctx.loader.await()
    expect(activated.sort()).toEqual(active ? modelIds : [])
  } finally {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
