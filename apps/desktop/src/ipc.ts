import type { DesktopFileActions } from '@deepseek-ai/dsh-client-ui-file-actions/types'
/** Typed preload operations exposed only by the Electron shell. */

export type { DesktopChannelState, DesktopChannelChangeResult } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { DesktopChannelBridge, DesktopChannelState } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopFileDrag } from '@deepseek-ai/dsh-util-file-drag'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  fileSave: 'altoaih-desktop:file-save',
  clipboardImageRead: 'altoaih-desktop:clipboard-image-read',
  shortcutsInput: 'altoaih-desktop:shortcuts-input',
  shortcutsCloseWindow: 'altoaih-desktop:shortcuts-close-window',
  shortcutsGet: 'altoaih-desktop:shortcuts-get',
  shortcutsEdit: 'altoaih-desktop:shortcuts-edit',
  shortcutsChanged: 'altoaih-desktop:shortcuts-changed',
  shortcutsRecording: 'altoaih-desktop:shortcuts-recording',
  boot: 'altoaih-desktop:boot',
  enterWorkspace: 'altoaih-desktop:enter-workspace',
  onboardingActive: 'altoaih-desktop:onboarding-active',
  onboardingApiKey: 'altoaih-desktop:onboarding-api-key',
  bootFailed: 'altoaih-desktop:boot-failed',
  browserAcquire: 'altoaih-desktop:browser-acquire',
  browserRelease: 'altoaih-desktop:browser-release',
  browserOpenRequested: 'altoaih-desktop:browser-open-requested',
  directoryPick: 'altoaih-desktop:directory-pick',
  fileDragPrepare: 'altoaih-desktop:file-drag-prepare',
  fileDragCancel: 'altoaih-desktop:file-drag-cancel',
  fileDragStart: 'altoaih-desktop:file-drag-start',
  fileDragRelease: 'altoaih-desktop:file-drag-release',
  deviceInfo: 'altoaih-desktop:device-info',
  localeBootstrap: 'altoaih-desktop:locale-bootstrap',
  localeChanged: 'altoaih-desktop:locale-changed',
  updatesChannelGet: 'altoaih-desktop:updates-channel-get',
  updatesChannelSet: 'altoaih-desktop:updates-channel-set',
  updatesChannelChanged: 'altoaih-desktop:updates-channel-changed',
  updatesStatus: 'altoaih-desktop:updates-status',
  updatesOpen: 'altoaih-desktop:updates-open',
  updatesPresentation: 'altoaih-desktop:updates-presentation',
  nativeThemeSet: 'altoaih-desktop:native-theme-set',
  windowFullscreen: 'altoaih-desktop:window-fullscreen',
  windowsAppearance: 'altoaih-desktop:windows-appearance',
  windowsMenu: 'altoaih-desktop:windows-menu',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install' | 'configuration'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
  /** Current filesystem failure, independent of previous cache cleanup attempts. */
  readonly downloadFailure?: 'space' | 'permission' | 'busy'
}

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'configuration'
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'download-space'
  | 'download-permission'
  | 'download-busy'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'fullscreen-timeout'

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
  readonly configurationError?: DesktopChannelState['error']
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface DshDesktopProductApi {
  readonly fileActions: DesktopFileActions
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly fileDrag: DesktopFileDrag
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  /**
   * Local machine description for the feedback questionnaire.
   * @returns `name=value` fields separated by `; `, with no hostname, user name, or serial number.
   */
  deviceInfo(): Promise<string>
  readonly updates: {
    readonly channels: DesktopChannelBridge
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'altoaih-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
