import { fileURLToPath } from 'node:url'

/** Display name of the site client; installation and runtime identifiers stay unchanged. */
export const SITE_CLIENT_PRODUCT_NAME = 'Altoai Harness'

/** Resolve the site's manual update source without inheriting upstream release settings. */
export function resolveSiteUpdateEnvironment(env) {
  const protocol = env.DSH_DESKTOP_AUTH_PROTOCOL
  if (protocol === undefined || protocol === '' || protocol === 'platform') return undefined
  if (protocol !== 'site-device') throw new Error('desktop update: invalid DSH_DESKTOP_AUTH_PROTOCOL')
  const origin = new URL(env.DSH_DESKTOP_SITE_ORIGIN ?? '')
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('desktop update: DSH_DESKTOP_SITE_ORIGIN must be an HTTPS origin')
  }
  return { origin: origin.origin }
}

/** Resolve the shared helper when TypeScript relocates source modules into lib/types. */
export const siteUpdateEnvironmentPlugin = {
  name: 'desktop-site-update-environment',
  resolveId(source, importer) {
    if (source !== '../scripts/site-update-environment.mjs'
      || importer !== fileURLToPath(new URL('../lib/types/site-update.js', import.meta.url))) return null
    return fileURLToPath(import.meta.url)
  },
}
