/** Welcome acknowledgement stored in the plugin configuration. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Last acknowledged welcome notice version. */
  welcomeNoticeVersion: Volatile<string | undefined>
  /** Whether the floating desktop pet is shown. */
  desktopPet: Volatile<boolean>
  /** Whether the agent uses the configured SSH host for project work. */
  sshEnabled: Volatile<boolean>
  /** Existing OpenSSH host alias. */
  sshHost: Volatile<string>
  /** Absolute remote workspace path. */
  sshWorkspace: Volatile<string>
}

/** Live welcome preference. */
export const Config = z.object({
  welcomeNoticeVersion: z.string().volatile(),
  desktopPet: z.boolean().default(true).volatile(),
  sshEnabled: z.boolean().default(false).volatile(),
  sshHost: z.string().default('').volatile(),
  sshWorkspace: z.string().default('').volatile(),
})

/** The browser consumes the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
