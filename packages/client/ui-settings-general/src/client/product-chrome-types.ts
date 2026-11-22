/** Writers for SSH remote workspace settings. */
export interface ProductChromeInjected {
  /** Persist the OpenSSH host alias. */
  setSshHost: (host: string) => void
  /** Persist the remote workspace path. */
  setSshWorkspace: (path: string) => void
  /** Probe the remote directory and register it as a workspace. */
  addSshWorkspace: () => Promise<void>
}
