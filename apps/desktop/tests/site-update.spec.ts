import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Rolldown } from 'tsdown'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { checkSiteRelease, resolveSiteUpdate } from '../src/site-update.ts'
import { resolveSiteUpdateEnvironment, siteUpdateEnvironmentPlugin } from '../scripts/site-update-environment.mjs'

vi.mock('../scripts/windows-sign.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/windows-sign.mjs')>(),
  createWindowsTokenSigner: () => () => { throw new Error('test must not sign artifacts') },
  installWindowsNsisBootstrapSigner: () => undefined,
  resolveWindowsUpdatePublisher: () => 'CN=Fixture,O=Fixture,C=CN',
}))

const config = { origin: 'https://site.invalid' }
const identity = { version: '1.0.0-rc.2', platform: 'win32', arch: 'x64' }
const release = { published: true, platform: 'win32', arch: 'x64', version: '1.0.0-rc.10', notes: 'Release notes', download_url: 'https://downloads.invalid/client.exe' }
const requestFor = (data: object) => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, data }))

describe('site manual releases', () => {
  it('compares prerelease precedence and keeps downloads in the browser', async () => {
    const request = requestFor(release)
    await expect(checkSiteRelease(config, identity, request)).resolves.toEqual({ kind: 'available', version: release.version, notes: release.notes, downloadURL: release.download_url })
    expect(request.mock.calls[0]![0]).toEqual(new URL('https://site.invalid/api/client/v1/version?platform=win32&arch=x64'))
    expect(request.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(['1.0.0-rc.2', '1.0.0-rc.1', '1.0.0-rc.2+build.99'])('reports current without downgrading to %s', async (version) => {
    await expect(checkSiteRelease(config, identity, requestFor({ ...release, version }))).resolves.toEqual({ kind: 'current' })
  })
  it('distinguishes unpublished targets', async () => {
    await expect(checkSiteRelease(config, identity, requestFor({ published: false, platform: 'win32', arch: 'x64' }))).resolves.toEqual({ kind: 'unpublished' })
  })
  it.each([{ version: 'broken' }, { download_url: 'http://download.invalid/file' }, { download_url: 'https://user:secret@download.invalid/file' }, { download_url: 'https://download.invalid/file#fragment' }, { download_url: 'javascript:alert(1)' }, { arch: 'arm64' }, { published: 'true' }])('rejects invalid wire fields %j', async (patch) => {
    await expect(checkSiteRelease(config, identity, requestFor({ ...release, ...patch }))).rejects.toThrow()
  })
  it('allows retry after network and HTTP failures', async () => {
    const request = requestFor(release).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(checkSiteRelease(config, identity, request)).rejects.toThrow()
    await expect(checkSiteRelease(config, identity, request)).rejects.toThrow()
    await expect(checkSiteRelease(config, identity, request)).resolves.toMatchObject({ kind: 'available' })
  })
  it('keeps upstream as default and validates site origins even without signing', () => {
    expect(resolveSiteUpdate({}, {})).toBeUndefined()
    expect(resolveSiteUpdate({ dshSiteUpdate: config })).toEqual(config)
    expect(resolveSiteUpdateEnvironment({ DSH_DESKTOP_AUTH_PROTOCOL: 'site-device', DSH_DESKTOP_SITE_ORIGIN: config.origin })).toEqual(config)
    for (const origin of ['', 'http://site.invalid', 'https://site.invalid/path', 'https://user@site.invalid']) {
      expect(() => resolveSiteUpdateEnvironment({ DSH_DESKTOP_AUTH_PROTOCOL: 'site-device', DSH_DESKTOP_SITE_ORIGIN: origin })).toThrow()
    }
  })
  it('bundles the shared helper from the relocated TypeScript output without a runtime import', async () => {
    const entry = fileURLToPath(new URL('../lib/types/site-update.js', import.meta.url))
    const bundle = await Rolldown.rolldown({
      input: entry,
      platform: 'node',
      plugins: [{
        name: 'emitted-site-update-fixture',
        load(id) {
          if (id === entry) return "export { resolveSiteUpdateEnvironment } from '../scripts/site-update-environment.mjs'"
          return null
        },
      }, siteUpdateEnvironmentPlugin],
    })
    try {
      const output = await bundle.generate({ format: 'esm' })
      const chunk = output.output[0]
      expect(chunk.type).toBe('chunk')
      if (chunk.type !== 'chunk') throw new Error('expected bundled JavaScript')
      expect(chunk.imports.filter(specifier => !specifier.startsWith('node:'))).toEqual([])
      expect(chunk.code).toContain('DSH_DESKTOP_SITE_ORIGIN')
      expect(chunk.code).not.toContain('../scripts/site-update-environment.mjs')
    } finally { await bundle.close() }
  })
  it.each(['0', '1'])('omits upstream feeds and mandatory policy for site packaging with unsigned=%s', (unsigned) => {
    const packaged = createElectronBuilderConfig({
      DSH_DESKTOP_AUTH_PROTOCOL: 'site-device', DSH_DESKTOP_SITE_ORIGIN: config.origin,
      DSH_DESKTOP_APP_ID: 'com.example.site', DSH_DESKTOP_UNSIGNED: unsigned,
      // Invalid upstream settings must never be resolved for site packages.
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'invalid', DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{',
    }, 'win32', 'x64')
    expect(packaged.extraMetadata).toMatchObject({ dshSiteUpdate: config })
    expect(packaged.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    expect(packaged.publish).toBeNull()
  })
  it('guards every automatic upstream entry and uses the manual site prompt first', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain('if (siteUpdate !== undefined) return openSiteUpdatePrompt()')
    expect(main).toContain('const automaticCheck = (): void => {\n    if (siteUpdate !== undefined) return')
    expect(main).toContain('siteUpdate === undefined ? resolveDesktopPolicyConfig(policyInput, !app.isPackaged) : undefined')
    expect(main).toContain('undefined, siteUpdate === undefined ? undefined : () => false, undefined,')
    const builder = readFileSync(new URL('../scripts/electron-builder-config.mjs', import.meta.url), 'utf8')
    expect(builder).toContain('const update = siteUpdate !== undefined || unsigned ? undefined')
    expect(builder).toContain('dshSiteUpdate: siteUpdate')
  })
})
