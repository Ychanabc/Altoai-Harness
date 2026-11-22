/** Writers for desktop pet and SSH remote settings. */
export interface ProductChromeInjected {
  /** Show or hide the desktop pet. */
  setDesktopPet: (enabled: boolean) => void
  /** Enable remote SSH execution for the agent. */
  setSshEnabled: (enabled: boolean) => void
  /** Persist the OpenSSH host alias. */
  setSshHost: (host: string) => void
  /** Persist the remote workspace path. */
  setSshWorkspace: (path: string) => void
}
