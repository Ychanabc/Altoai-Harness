/**
 * Model selection plugin, node half. Pure UI plugin: the empty apply exists
 * so the plugin appears in the host cordis.yml / Loader; the browser half
 * ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Deployment-owned source grouping synced to the browser. */
export interface Config {
  /** Route shown under the default official source, if configured. */
  officialProvider: Volatile<string>
}

/** Leave source grouping disabled unless enabled by the deployment. */
export const Config = z.object({ officialProvider: z.string().default('').volatile() })

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
