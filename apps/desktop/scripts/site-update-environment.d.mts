/** Display name of the site client. */
export const SITE_CLIENT_PRODUCT_NAME: 'Altoai Harness'

/** Site-owned manual release endpoint. */
export interface SiteUpdateConfig { readonly origin: string }
/** Resolve public build inputs; platform mode returns undefined. */
export function resolveSiteUpdateEnvironment(env: NodeJS.ProcessEnv): SiteUpdateConfig | undefined

/** Resolve the shared helper from relocated TypeScript output for the main bundle. */
export const siteUpdateEnvironmentPlugin: import('tsdown').Rolldown.Plugin
