/**
 * Browser-safe Workspace path and display helpers.
 * @module @deepseek-ai/dsh-util-workspace-path
 */
import { sessionFileAddress } from './file-address.ts'

/** Whether a path uses a Windows drive or UNC prefix. */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/** A password-free SSH authority and its absolute POSIX directory. */
export interface SshWorkspaceLocation {
  host: string
  remotePath: string
}

/** Parsed components of a managed SSH authority (`user@host:port`). */
export interface SshWorkspaceAuthority {
  readonly username: string
  readonly host: string
  readonly port: number
}

/**
 * Parse a stored SSH workspace location without interpreting it as a local path or decoding its directory.
 * @param path - Candidate workspace path.
 * @returns The SSH authority and directory, or undefined for other paths and malformed locations.
 */
export function parseSshWorkspacePath(path: string): SshWorkspaceLocation | undefined {
  const location = /^ssh:\/\/((?:[a-zA-Z0-9_.%-]+@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:.]+\])(?::[0-9]+)?)(\/[^\0]*)$/u.exec(path)
  if (location === null || location[0] !== path) return undefined
  const [, host, remotePath] = location
  if (host === undefined || remotePath === undefined) return undefined
  return { host, remotePath }
}

/**
 * Split a stored SSH authority into username, host/IP, and port for editing forms.
 * @param authority - Authority part from {@link parseSshWorkspacePath} (for example `alice@192.0.2.10:22`).
 * @returns Decoded username, unbracketed host, and numeric port, or undefined when malformed.
 */
export function parseSshWorkspaceAuthority(authority: string): SshWorkspaceAuthority | undefined {
  const match = /^(?:([a-zA-Z0-9_.%-]+)@)?(\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9_][a-zA-Z0-9_.-]*)(?::([0-9]+))?$/u.exec(authority)
  if (match === null) return undefined
  const [, rawUser = '', rawHost, rawPort] = match
  if (rawHost === undefined) return undefined
  let username = rawUser
  try {
    username = decodeURIComponent(rawUser)
  } catch (_invalidEncoding) {
    // Keep the raw authority segment when a legacy alias contains a literal percent sign.
    username = rawUser
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const port = rawPort === undefined ? 22 : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { username, host, port }
}

/**
 * Whether a path is absolute in either spelling the Host accepts: POSIX (`/a/b`) or Windows drive or UNC.
 * @param path - the path to classify.
 * @returns `true` for an absolute path; `false` for a Workspace-relative one.
 */
export function isAbsoluteWorkspacePath(path: string): boolean {
  return parseSshWorkspacePath(path) !== undefined || path.startsWith('/') || isWindowsStylePath(path)
}

/**
 * Resolve a Workspace-relative path into the Host-facing spelling used by path operations.
 * @param cwd - Session Workspace root, when known.
 * @param path - Absolute or Workspace-relative path; leading `./` segments are dropped when joining.
 * @returns an absolute path when a Workspace root is available, otherwise the original path.
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (isAbsoluteWorkspacePath(path)) return path
  if (cwd === undefined || cwd === '') return path
  const separator = isWindowsStylePath(cwd) && cwd.includes('\\') ? '\\' : '/'
  const base = cwd.replace(/[/\\]+$/, '')
  const relative = path.replace(/^(?:\.?[/\\])+/, '')
  return `${base}${separator}${relative}`
}

/**
 * Abbreviate a POSIX home directory for display.
 * @param path - Absolute or already-short display path.
 * @param home - Host account home; absent skips abbreviation.
 * @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
 */
export function abbreviateHomePath(path: string, home?: string): string {
  if (home === undefined || home === '') return path
  if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path
  const root = home.replace(/\/+$/, '')
  if (root === '' || root === '/') return path
  if (path.replace(/\/+$/, '') === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return path
}

/**
 * Read the final non-empty segment of a Workspace path for display.
 * Workspace-label surfaces use this helper instead of deriving another basename.
 * @param path - Workspace directory path using POSIX or Windows separators.
 * @returns the final segment, or an empty string for a separator-only path.
 */
export function workspaceTitleOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/**
 * Split a path for display: the directories through their last separator, and
 * the final segment after it. Both `/` and `\` separate, so a Windows path
 * splits where its own segments end; trailing separators are dropped first, so
 * a directory path names its own last segment. A path with no separator, or a
 * separator-only path, is all name.
 * @param path - file or directory path using POSIX or Windows separators.
 * @returns the directory prefix (possibly empty) and the final segment.
 */
export function pathPartsOf(path: string): { readonly directory: string; readonly name: string } {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed === '') return { directory: '', name: path }
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1
  return { directory: trimmed.slice(0, cut), name: trimmed.slice(cut) }
}

export * from './file-address.ts'

/**
 * The address for a path as a caller holds it: a relative path, or an absolute
 * path inside the Session's workspace, becomes a `session`-scoped address; an
 * absolute path outside it, or one whose workspace root is unknown, keeps its
 * absolute path in that Session's address.
 * @param sessionId - the Session the path is read in.
 * @param cwd - that Session's workspace root, when known.
 * @param path - absolute or workspace-relative path, in either separator spelling.
 * @returns the `dsh-resource://file/…` address.
 */
export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized)
  const root = cwd === undefined ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
  if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
  return sessionFileAddress(sessionId, normalized)
}

/**
 * Strip the workspace root from a workspace-rooted absolute path (display only).
 * @param text - the path to shorten.
 * @param cwd - session workspace root; absent or empty leaves the path unchanged.
 * @returns the path relative to the workspace root, or unchanged when it is not rooted there.
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/**
 * Address a decoded absolute file path through the authenticated file route.
 * @param base - HTTP(S) application base, including its deployment prefix, or `dsh-app://app/`.
 * @param path - Native file path; URL escapes in authored Markdown must already be decoded.
 * @returns File URL, or undefined for unsupported transports and non-absolute paths.
 */
export function fileMediaUrl(base: string, path: string): string | undefined {
  if ((!/^https?:/u.test(base) && !base.startsWith('dsh-app://app/')) || !isAbsoluteWorkspacePath(path)
    || parseSshWorkspacePath(path) !== undefined || /^[/\\]{2}/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return undefined
  return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href
}
