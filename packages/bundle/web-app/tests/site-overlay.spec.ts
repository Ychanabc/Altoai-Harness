/** Both GUI profiles receive the site deployment through their shared Web bundle. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
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

it('composes the real Desktop profile with site authorization and Messages defaults', () => {
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
      baseURL: 'https://ai.vpss.eu.cc', catalogProtocol: 'site', thinking: 'disabled',
    })
    expect(rows.find(row => row.id === 'ui-model-selection')?.config).toMatchObject({ officialProvider: 'deepseek-account' })
    expect(rows.find(row => row.id === 'ui-settings-models')?.config).toMatchObject({ officialProvider: 'deepseek-account' })
    expect(rows.find(row => row.id === 'agent-default-model')?.config).toMatchObject({ provider: 'deepseek-account' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})
