/** Manual site release checks; no Electron updater, installation, or mandatory policy. */
import { gt, valid } from 'semver'
import { resolveSiteUpdateEnvironment, SITE_CLIENT_PRODUCT_NAME, type SiteUpdateConfig } from '../scripts/site-update-environment.mjs'

export { SITE_CLIENT_PRODUCT_NAME }

/** Wire results distinguish an unpublished target from a current installed release. */
export type SiteReleaseResult = { kind: 'unpublished' } | { kind: 'current' } | {
  kind: 'available'
  version: string
  notes: string
  downloadURL: string
}

/**
 * Resolve packaged site mode or explicit development inputs. Invalid metadata fails before polling starts.
 * @param manifest - Installed package metadata.
 * @param env - Development environment; ignored for packaged applications.
 * @returns Site configuration, or undefined for upstream mode.
 */
export function resolveSiteUpdate(manifest: unknown, env?: NodeJS.ProcessEnv): SiteUpdateConfig | undefined {
  if (env !== undefined) return resolveSiteUpdateEnvironment(env)
  if (typeof manifest !== 'object' || manifest === null || !('altoaihSiteUpdate' in manifest)) return undefined
  const config: unknown = manifest.altoaihSiteUpdate
  if (typeof config !== 'object' || config === null || !('origin' in config) || typeof config.origin !== 'string') {
    throw new Error('desktop update: invalid site metadata')
  }
  return resolveSiteUpdateEnvironment({ ALTOAIH_DESKTOP_AUTH_PROTOCOL: 'site-device', ALTOAIH_DESKTOP_SITE_ORIGIN: config.origin })
}

/**
 * Query the public site API anonymously and compare full SemVer precedence.
 * @param config - Validated site origin.
 * @param identity - Installed shell version and target, independent of server/runtime versions.
 * @param request - Fetch transport; defaults to the desktop runtime transport.
 * @returns Explicit publication or comparison result; transport and invalid metadata reject for retry.
 */
export async function checkSiteRelease(config: SiteUpdateConfig,
  identity: { version: string; platform: string; arch: string }, request: typeof fetch = fetch): Promise<SiteReleaseResult> {
  if (valid(identity.version) === null) throw new Error('desktop update: invalid installed version')
  const url = new URL('/api/client/v1/version', config.origin)
  url.search = new URLSearchParams({ platform: identity.platform, arch: identity.arch }).toString()
  const response = await request(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('desktop update: site release request failed')
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('success' in body) || body.success !== true || !('data' in body)
    || typeof body.data !== 'object' || body.data === null) throw new Error('desktop update: invalid site response')
  const data = body.data
  if (!('platform' in data) || data.platform !== identity.platform || !('arch' in data) || data.arch !== identity.arch
    || !('published' in data) || typeof data.published !== 'boolean') throw new Error('desktop update: mismatched site target')
  if (!data.published) return { kind: 'unpublished' }
  if (!('version' in data) || typeof data.version !== 'string' || valid(data.version) === null
    || !('notes' in data) || typeof data.notes !== 'string' || !('download_url' in data) || typeof data.download_url !== 'string') {
    throw new Error('desktop update: invalid site release')
  }
  const download = new URL(data.download_url)
  if (download.protocol !== 'https:' || download.username || download.password || download.hash) throw new Error('desktop update: invalid download URL')
  return gt(data.version, identity.version)
    ? { kind: 'available', version: data.version, notes: data.notes, downloadURL: download.href } : { kind: 'current' }
}
