/**
 * Sidebar/workspace chrome preferences mirrored from the general settings
 * namespace: last-used SSH host and remote directory.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Durable chrome fields stored with the General plugin namespace. */
export interface ProductChromeState {
  /** Existing OpenSSH host alias. */
  sshHost: string
  /** Absolute remote workspace path. */
  sshWorkspace: string
  /** Service revision; -1 until first sync. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type ProductChromeActions = {
  sync: (
    draft: ProductChromeState,
    next: Omit<ProductChromeState, 'revision'>,
    revision: number,
  ) => void
}

/**
 * Declares the product-chrome store.
 * @returns the store handle.
 */
export function createProductChromeStore(): EngineStoreHandle<ProductChromeState, ProductChromeActions> {
  return defineStore({
    init: (): ProductChromeState => ({
      sshHost: '', sshWorkspace: '', revision: -1,
    }),
    actions: {
      sync: (d, next, revision) => {
        if (revision <= d.revision) return
        d.sshHost = next.sshHost
        d.sshWorkspace = next.sshWorkspace
        d.revision = revision
      },
    },
  })
}
